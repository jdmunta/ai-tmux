import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { AitError, MSG } from './errors.js';
import { NAME_RE } from './validate.js';
import { sanitize } from './sanitize.js';
import { MIN_TMUX } from './config.js';

export const ALLOWED = new Set([
  'new-session', 'list-sessions', 'list-panes', 'set-option', 'switch-client', 'attach-session',
  'kill-session', 'kill-server', 'rename-session', 'capture-pane', 'bind-key', 'list-keys',
  'show', 'display-message',
]);

const NO_SERVER = /no server running|error connecting|failed to connect|no current/i;
const NO_SESSION = /can't find session|no such session|session not found/i;

export function target(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new AitError(2, MSG.nameInvalid);
  return `=ait-${name}`;
}

export function insideTmux(env, socket) {
  if (!env.TMUX) return false;
  const sock = String(env.TMUX).split(',')[0];
  return path.basename(sock) === socket;
}

export function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

export function versionOk(v) {
  return !!v && (v.major > MIN_TMUX.major || (v.major === MIN_TMUX.major && v.minor >= MIN_TMUX.minor));
}

export function createTmux(cfg, { execFileImpl = execFile, spawnImpl = spawn, bin = 'tmux', timeoutMs = 2000, env = process.env } = {}) {
  const base = cfg.socket === 'default' ? [] : ['-L', cfg.socket];
  // The API token must never reach the tmux server (and so never reach Claude).
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'AIT_API_TOKEN'));

  async function run(args, { timeout = timeoutMs } = {}) {
    if (!ALLOWED.has(args[0])) throw new AitError(7, 'That tmux command is not allowed.');
    return new Promise((resolve, reject) => {
      execFileImpl(bin, [...base, ...args], { timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20, encoding: 'utf8', env: childEnv }, (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout ?? ''));
        if (err.code === 'ENOENT') return reject(new AitError(10, MSG.tmuxMissing));
        const e = new AitError(7, MSG.tmuxUnreachable);
        e.stderr = String(stderr ?? '');
        if (err.killed || err.signal) e.timeout = true;
        return reject(e);
      });
    });
  }

  function version() {
    return new Promise((resolve, reject) => {
      execFileImpl(bin, ['-V'], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
        if (err) return reject(err.code === 'ENOENT' ? new AitError(10, MSG.tmuxMissing) : new AitError(7, MSG.tmuxUnreachable));
        const v = parseVersion(String(stdout));
        if (!v) return reject(new AitError(10, MSG.tmuxMissing));
        return resolve(v);
      });
    });
  }

  async function listSessions() {
    let out;
    try {
      out = await run(['list-panes', '-a', '-F', '#{session_name}|#{session_attached}|#{pane_dead}|#{pane_dead_status}']);
    } catch (e) {
      if (e.stderr && NO_SERVER.test(e.stderr)) return [];
      throw e;
    }
    const map = new Map();
    for (const line of out.split('\n')) {
      const [sn, att, dead, st] = line.split('|');
      if (!sn || !sn.startsWith('ait-')) continue;
      const name = sn.slice(4);
      if (!NAME_RE.test(name) || map.has(name)) continue;
      map.set(name, {
        name,
        attached: Number(att) || 0,
        dead: dead === '1',
        deadStatus: st === undefined || st === '' ? null : Number(st),
      });
    }
    return [...map.values()];
  }

  async function newSession({ name, dir, env: sessionEnv = {}, argv, remain = true }) {
    target(name);
    const args = ['new-session', '-d', '-s', `ait-${name}`, '-c', dir];
    for (const [k, v] of Object.entries(sessionEnv)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new AitError(7, 'Invalid environment name.');
      args.push('-e', `${k}=${v}`);
    }
    args.push('--', ...argv);
    await run(args);
    if (remain) await run(['set-option', '-w', '-t', `${target(name)}:`, 'remain-on-exit', 'on']);
  }

  async function capture(name, lines = 40) {
    const out = await run(['capture-pane', '-p', '-t', `${target(name)}:`, '-S', `-${lines}`]);
    return out.split('\n').slice(-lines).join('\n');
  }

  async function killSession(name) {
    try {
      await run(['kill-session', '-t', target(name)]);
    } catch (e) {
      if (e.stderr && (NO_SESSION.test(e.stderr) || NO_SERVER.test(e.stderr))) return;
      throw e;
    }
  }

  async function renameSession(oldName, newName) {
    target(newName);
    try {
      await run(['rename-session', '-t', target(oldName), `ait-${newName}`]);
    } catch (e) {
      if (e.stderr && (NO_SESSION.test(e.stderr) || NO_SERVER.test(e.stderr))) return;
      throw e;
    }
  }

  async function setStatus(name, text) {
    const safe = sanitize(text).replace(/#/g, '##').slice(0, 80);
    await run(['set-option', '-t', target(name), 'status-right-length', '90']);
    await run(['set-option', '-t', target(name), 'status-right', safe]);
  }

  async function prefix() {
    try {
      const out = (await run(['show', '-gv', 'prefix'])).trim();
      return /^[A-Za-z0-9-]{1,16}$/.test(out) ? out : 'C-b';
    } catch {
      return 'C-b';
    }
  }

  // Binds the return key on the ait server only. On a shared default server an
  // existing binding is never overwritten.
  async function bindReturnKey(key) {
    if (!/^[A-Za-z0-9-]{1,16}$/.test(key)) throw new AitError(7, 'Invalid return key.');
    if (cfg.socket === 'default') {
      let keys = '';
      try { keys = await run(['list-keys', '-T', 'prefix']); } catch { keys = ''; }
      const re = new RegExp(`-T prefix\\s+${key.replace(/[-]/g, '\\-')}\\s`);
      if (re.test(keys)) return { bound: false, warning: `Key ${key} is already bound; left untouched.` };
    }
    await run(['bind-key', '-T', 'prefix', key, 'switch-client', '-t', '=ait-dash']);
    return { bound: true };
  }

  async function killServer() {
    await run(['kill-server']);
  }

  async function switchClient(name) {
    await run(['switch-client', '-t', target(name)]);
  }

  function attach(name) {
    const t = target(name);
    return new Promise((resolve, reject) => {
      const c = spawnImpl(bin, [...base, 'attach-session', '-t', t], { stdio: 'inherit', env: childEnv });
      c.on('error', (e) => reject(e.code === 'ENOENT' ? new AitError(10, MSG.tmuxMissing) : new AitError(7, MSG.tmuxUnreachable)));
      c.on('exit', () => resolve());
    });
  }

  async function switchOrAttach(name) {
    const t = target(name);
    try {
      if (insideTmux(env, cfg.socket)) await run(['switch-client', '-t', t]);
      else await attach(name);
    } catch (e) {
      if (e.stderr && NO_SESSION.test(e.stderr)) throw new AitError(8, MSG.gone(name));
      throw e;
    }
  }

  return { run, version, listSessions, newSession, capture, killSession, renameSession, setStatus, prefix, bindReturnKey, killServer, switchClient, attach, switchOrAttach };
}
