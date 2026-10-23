import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AitError } from './errors.js';
import { acquireLock } from './lock.js';
import { decode } from './keys.js';
import { lines, dialogFor, sortSessions, useAscii } from './render.js';
import { createUi, handleKey, setStatus, syncSelection } from './ui.js';
import { createTracker } from './state.js';
import { createNotifier } from './notify.js';
import { prune, loadRegistry } from './registry.js';
import { launchSession } from './launch.js';
import { listSessions, killSession, removeSession, renameSession, openSession } from './service.js';

const REFRESH_MS = 1000;
const STATUS_MS = 6000;

export async function run({ cfg, tmux, stdin = process.stdin, stdout = process.stdout, env = process.env }) {
  const lock = await acquireLock(cfg.home);
  if (!lock.ok) throw new AitError(7, 'A dashboard is already running.');
  try { prune(cfg.home, loadRegistry(cfg.home).reg); } catch { /* cleanup is best effort */ }

  const ui = createUi(process.cwd());
  const tracker = createTracker({ debounceMs: 500 });
  const notifier = createNotifier({ cfg, env, bell: () => stdout.write('\x07') });
  let sessions = [];
  let stale = false;
  let banner = '';
  let degraded = false;
  let loading = true;
  let refreshing = false;
  let closed = false;
  let timer = null;
  let watcher = null;
  let watchTimer = null;
  let done = () => {};

  function draw() {
    if (closed) return;
    const now = Date.now();
    const model = {
      sessions, selected: ui.selected, stale, banner, degraded, loading,
      status: now - ui.statusAt < STATUS_MS ? ui.status : '',
      dialog: dialogFor(ui),
    };
    const rows = stdout.rows || 24;
    const cols = stdout.columns || 80;
    const out = lines(model, { cols, rows, ascii: useAscii(env), noColor: !!env.NO_COLOR, home: os.homedir(), now });
    let buf = '\x1b[H';
    out.forEach((l, i) => { buf += `\x1b[${i + 1};1H${l}\x1b[K`; });
    buf += `\x1b[${out.length + 1};1H\x1b[J`;
    stdout.write(buf);
  }

  async function refresh() {
    if (refreshing || closed) return;
    refreshing = true;
    try {
      const list = await listSessions({ cfg, tmux });
      stale = list.stale;
      banner = list.banner || '';
      degraded = list.degraded;
      loading = false;
      const now = Date.now();
      const { shown, transitions } = tracker.update(
        list.sessions.map((s) => ({ name: s.name, state: s.state, since: s.since, attached: s.attached })), now,
      );
      sessions = sortSessions(list.sessions.map((s) => {
        const sh = shown.get(s.name);
        return sh ? { ...s, state: sh.state, since: sh.since } : s;
      }));
      if (transitions.length) {
        const byName = new Map(sessions.map((s) => [s.name, s]));
        const tr = transitions.map((t) => ({ ...t, dir: byName.get(t.name) ? byName.get(t.name).dir : '' }));
        notifier.fire(tr);
        const w = tr.filter((t) => t.to === 'waiting').map((t) => t.name);
        if (w.length) setStatus(ui, `${w.join(', ')} now WAITING`, now);
      }
    } catch {
      stale = true;
    } finally {
      refreshing = false;
    }
    syncSelection(ui, sessions);
    draw();
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearTimeout(watchTimer);
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    stdin.removeListener('data', onData);
    if (stdin.isTTY) { try { stdin.setRawMode(false); } catch { /* ignore */ } }
    stdin.pause();
    stdout.write('\x1b[?25h\x1b[?1049l');
    lock.release();
  }

  function finish() {
    cleanup();
    done();
  }

  async function exec(cmd) {
    try {
      switch (cmd.type) {
        case 'quit': finish(); return;
        case 'open':
          await openSession({ cfg, tmux, name: cmd.name });
          break;
        case 'new': {
          const r = await launchSession({ cfg, tmux, name: cmd.name, dir: cmd.dir, args: [], confirmProjectHooks: !!cmd.confirm, env });
          setStatus(ui, `Started ${r.entry.name}.`);
          await refresh();
          break;
        }
        case 'rename':
          await renameSession({ cfg, tmux, name: cmd.name, id: cmd.id, newName: cmd.newName });
          setStatus(ui, `Renamed to ${cmd.newName}.`);
          await refresh();
          break;
        case 'kill':
          await killSession({ cfg, tmux, name: cmd.name, id: cmd.id });
          setStatus(ui, `Killed ${cmd.name}.`);
          await refresh();
          break;
        case 'remove':
          await removeSession({ cfg, tmux, name: cmd.name, id: cmd.id });
          setStatus(ui, `Removed ${cmd.name}.`);
          await refresh();
          break;
        default:
          break;
      }
    } catch (e) {
      if (e instanceof AitError && e.needsConfirm && cmd.type === 'new') {
        ui.mode = 'hooks';
        ui.pending = cmd;
      } else {
        setStatus(ui, e instanceof AitError ? e.message : 'Something went wrong.');
      }
    }
  }

  async function onData(buf) {
    for (const key of decode(buf.toString('utf8'))) {
      if (closed) return;
      const cmd = handleKey(ui, key, sessions);
      if (cmd) await exec(cmd);
      draw();
    }
  }

  return new Promise((resolve) => {
    done = resolve;
    stdout.write('\x1b[?1049h\x1b[?25l');
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdout.on('resize', draw);
    process.once('SIGTERM', finish);
    process.once('SIGHUP', finish);
    try {
      watcher = fs.watch(path.join(cfg.home, 'events'), () => {
        clearTimeout(watchTimer);
        watchTimer = setTimeout(refresh, 100);
      });
      watcher.on('error', () => {});
    } catch { watcher = null; }
    timer = setInterval(refresh, REFRESH_MS);
    draw();
    refresh();
  });
}
