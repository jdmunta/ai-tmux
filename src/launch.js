import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AitError, MSG } from './errors.js';
import * as vd from './validate.js';
import { sanitize } from './sanitize.js';
import { sessionFile } from './paths.js';
import { EVENTS } from './hook.js';
import { loadRegistry, saveRegistry, addEntry, removeEntry, nameTaken } from './registry.js';
import { audit } from './audit.js';

const MAX_SETTINGS = 1024 * 1024;
const DANGEROUS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--mcp-config']);

// Finds `claude` on PATH using absolute entries only. Refuses world-writable locations.
export function resolveClaude(env = process.env) {
  let unsafe = false;
  for (const d of String(env.PATH || '').split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    const p = path.join(d, 'claude');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      const real = fs.realpathSync(p);
      if (!fs.statSync(real).isFile()) continue;
      const ww = (fs.statSync(path.dirname(real)).mode & 0o002) !== 0 || (fs.statSync(real).mode & 0o002) !== 0;
      if (ww) { unsafe = true; continue; }
      return { path: real, worldWritable: false };
    } catch { /* try next entry */ }
  }
  return { path: null, worldWritable: unsafe };
}

// Fails closed: unreadable, oversized or invalid settings count as "has hooks".
export function projectHooks(dir) {
  for (const f of ['settings.json', 'settings.local.json']) {
    const p = path.join(dir, '.claude', f);
    let st;
    try { st = fs.statSync(p); } catch (e) {
      if (e.code === 'ENOENT') continue;
      return true;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_SETTINGS) return true;
    try {
      const o = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (o && typeof o === 'object' && o.hooks) return true;
    } catch { return true; }
  }
  return false;
}

export function checkArgs(args) {
  if (!Array.isArray(args) || args.length > 32) throw new AitError(2, 'Too many Claude arguments (max 32).');
  for (const a of args) {
    if (typeof a !== 'string' || a.length > 256 || a.includes('\0')) throw new AitError(2, 'Invalid Claude argument.');
    if (a === '--settings' || a.startsWith('--settings=')) throw new AitError(2, '--settings is set by ait and cannot be overridden.');
  }
  let dangerous = false;
  args.forEach((a, i) => {
    if (DANGEROUS.has(a) || a.startsWith('--mcp-config=')) dangerous = true;
    if (a === '--permission-mode=bypassPermissions') dangerous = true;
    if (a === '--permission-mode' && args[i + 1] === 'bypassPermissions') dangerous = true;
  });
  return { dangerous };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function writeSettings(home, hookName) {
  const script = fileURLToPath(new URL('../bin/ait-hook.js', import.meta.url));
  const hooks = {};
  for (const ev of EVENTS) {
    const group = { hooks: [{ type: 'command', command: `${shq(process.execPath)} ${shq(script)} ${ev}` }] };
    if (ev.endsWith('ToolUse')) group.matcher = '*';
    hooks[ev] = [group];
  }
  const text = JSON.stringify({ hooks }, null, 2);
  const file = sessionFile(home, 'settings', hookName);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  const hash = sha(text);
  if (sha(fs.readFileSync(file, 'utf8')) !== hash) throw new AitError(7, 'The hook settings file changed while writing.');
  return { file, hash };
}

function gitBranch(dir, execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000, encoding: 'utf8' }, (err, out) => {
      const b = err ? '' : sanitize(String(out).trim()).slice(0, 200);
      resolve(b || null);
    });
  });
}

function dropFiles(home, hookName) {
  for (const sub of ['events', 'settings']) {
    try { fs.rmSync(sessionFile(home, sub, hookName), { force: true }); } catch { /* ignore */ }
  }
}

export async function launchSession({ cfg, tmux, name, dir, args = [], confirmProjectHooks = false, confirmDangerousArgs = false, env = process.env, execFileImpl = execFile }) {
  const nv = vd.name(name);
  if (!nv.ok) throw new AitError(nv.code, nv.error);
  const dv = vd.dir(dir);
  if (!dv.ok) throw new AitError(dv.code, dv.error);
  const { dangerous } = checkArgs(args);

  const claude = resolveClaude(env);
  if (!claude.path) throw new AitError(6, MSG.noClaude);

  const { reg } = loadRegistry(cfg.home);
  let live = [];
  try { live = await tmux.listSessions(); } catch { live = []; }
  if (nameTaken(reg, name) || live.some((s) => s.name === name)) throw new AitError(3, MSG.taken(name));

  if (projectHooks(dv.path) && !confirmProjectHooks) {
    const e = new AitError(7, MSG.projectHooks, 428);
    e.needsConfirm = true;
    throw e;
  }
  if (dangerous && !(confirmDangerousArgs || confirmProjectHooks)) {
    const e = new AitError(7, MSG.dangerousArgs, 428);
    e.needsConfirm = true;
    throw e;
  }

  const branch = await gitBranch(dv.path, execFileImpl);
  const settings = writeSettings(cfg.home, name);
  const entry = addEntry(reg, {
    name, dir: dv.path, branch, args: [...args], createdAt: Date.now(),
    claudeSessionId: null, exit: null, hookName: name, settingsHash: settings.hash,
  });
  saveRegistry(cfg.home, reg);

  try {
    await tmux.newSession({
      name,
      dir: dv.path,
      env: { AIT_SESSION: name },
      argv: [claude.path, '--settings', settings.file, ...args],
    });
  } catch (e) {
    removeEntry(reg, name);
    saveRegistry(cfg.home, reg);
    dropFiles(cfg.home, name);
    audit(cfg.home, { action: 'new', session: name, id: entry.id, result: 'error' });
    throw e;
  }

  try {
    const prefix = await tmux.prefix();
    await tmux.bindReturnKey(cfg.returnKey);
    await tmux.setStatus(name, `${name} · ${prefix} ${cfg.returnKey} → dashboard`);
  } catch { /* cosmetic; the session is already running */ }

  audit(cfg.home, { action: dangerous ? 'new-dangerous-args' : 'new', session: name, id: entry.id, result: 'ok' });
  return { entry, claude: claude.path };
}
