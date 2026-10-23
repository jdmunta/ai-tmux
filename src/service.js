import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { AitError, MSG } from './errors.js';
import * as vd from './validate.js';
import { loadRegistry, saveRegistry, getEntry, removeEntry } from './registry.js';
import { readEvent } from './hook.js';
import { resolve as resolveState, needsCapture, validEvent } from './state.js';
import { sortSessions, counts } from './render.js';
import { audit } from './audit.js';
import { safeFile, sessionFile, atomicWrite } from './paths.js';
import { resolveClaude } from './launch.js';
import { versionOk } from './tmux.js';
import { checkSocketDir, socketDir } from './security.js';

function checkName(name) {
  const v = vd.name(name);
  if (!v.ok) throw new AitError(v.code, v.error);
}

function dropFiles(home, hookName) {
  for (const sub of ['events', 'settings']) {
    try { fs.rmSync(sessionFile(home, sub, hookName), { force: true }); } catch { /* ignore */ }
  }
}

function purgeAuditFor(home, name) {
  try {
    const file = safeFile(home, '', 'audit.log');
    const keep = fs.readFileSync(file, 'utf8').split('\n').filter((l) => {
      if (!l) return false;
      try { return JSON.parse(l).session !== name; } catch { return true; }
    });
    atomicWrite(file, keep.length ? keep.join('\n') + '\n' : '');
  } catch { /* no log */ }
}

export function entryToSession(entry, extra = {}) {
  return {
    id: entry.id, name: entry.name, dir: entry.dir, branch: entry.branch,
    state: 'running', kind: null, since: entry.createdAt, source: 'hook', degraded: false,
    attached: false, createdAt: entry.createdAt, exit: null, ...extra,
  };
}

export async function listSessions({ cfg, tmux }, { verbose = false } = {}) {
  const { reg, banner } = loadRegistry(cfg.home);
  let infos = [];
  let stale = false;
  try { infos = await tmux.listSessions(); } catch { stale = true; }
  const map = new Map(infos.map((i) => [i.name, i]));
  const now = Date.now();
  const sessions = [];
  let dirty = false;
  for (const entry of Object.values(reg.sessions)) {
    const info = map.get(entry.name) || null;
    const event = readEvent(cfg.home, entry.hookName);
    let capture = null;
    if (!stale && needsCapture({ entry, info, event, now })) {
      try { capture = await tmux.capture(entry.name, 40); } catch { capture = null; }
    }
    const r = resolveState({ entry, info, stale, event, capture, now });
    if (r.state === 'done' && !entry.exit && r.exit) { entry.exit = r.exit; dirty = true; }
    if (event && event.claudeSessionId && event.claudeSessionId !== entry.claudeSessionId && validEvent(event, entry, now)) {
      entry.claudeSessionId = event.claudeSessionId;
      dirty = true;
    }
    const s = {
      id: entry.id, name: entry.name, dir: entry.dir, branch: entry.branch,
      state: r.state, kind: r.kind, since: Math.min(r.since, now), source: r.source,
      degraded: r.degraded, attached: !!(info && info.attached > 0), createdAt: entry.createdAt, exit: r.exit,
    };
    if (verbose) { s.args = [...entry.args]; s.claudeSessionId = entry.claudeSessionId; }
    sessions.push(s);
  }
  if (dirty) { try { saveRegistry(cfg.home, reg); } catch { /* ignore */ } }
  const sorted = sortSessions(sessions);
  const out = { stale, degraded: sorted.some((s) => s.degraded), counts: counts(sorted), sessions: sorted };
  if (banner) out.banner = banner;
  return out;
}

export async function getSession(ctx, name, opts = {}) {
  checkName(name);
  const list = await listSessions(ctx, opts);
  const s = list.sessions.find((x) => x.name === name);
  if (!s) throw new AitError(8, MSG.gone(name));
  return s;
}

export async function killSession({ cfg, tmux, name, id, purgeLog = false }) {
  checkName(name);
  const { reg } = loadRegistry(cfg.home);
  const entry = getEntry(reg, name);
  if (!entry || (id !== undefined && entry.id !== id)) throw new AitError(8, MSG.gone(name));
  await tmux.killSession(name);
  removeEntry(reg, name);
  saveRegistry(cfg.home, reg);
  dropFiles(cfg.home, entry.hookName);
  audit(cfg.home, { action: 'kill', session: name, id: entry.id, result: 'ok' });
  if (purgeLog) purgeAuditFor(cfg.home, name);
  return { ok: true, message: `Killed ${name}.` };
}

export async function removeSession({ cfg, tmux, name, id, purgeLog = false }) {
  checkName(name);
  const { reg } = loadRegistry(cfg.home);
  const entry = getEntry(reg, name);
  if (!entry || (id !== undefined && entry.id !== id)) throw new AitError(8, MSG.gone(name));
  const info = (await tmux.listSessions()).find((s) => s.name === name);
  if (info && !info.dead) throw new AitError(7, `${name} is still running. Use kill to stop it.`, 409);
  if (info) await tmux.killSession(name);
  removeEntry(reg, name);
  saveRegistry(cfg.home, reg);
  dropFiles(cfg.home, entry.hookName);
  audit(cfg.home, { action: 'rm', session: name, id: entry.id, result: 'ok' });
  if (purgeLog) purgeAuditFor(cfg.home, name);
  return { ok: true, message: `Removed ${name}.` };
}

export async function renameSession({ cfg, tmux, name, id, newName }) {
  checkName(name);
  const nv = vd.name(newName);
  if (!nv.ok) throw new AitError(nv.code, nv.error);
  const { reg } = loadRegistry(cfg.home);
  const entry = getEntry(reg, name);
  if (!entry || (id !== undefined && entry.id !== id)) throw new AitError(8, MSG.gone(name));
  if (newName === name) return entryToSession(entry);
  const clash = Object.values(reg.sessions).some((e) => e !== entry && (e.name === newName || e.hookName === newName));
  if (clash) throw new AitError(3, MSG.taken(newName));
  await tmux.renameSession(name, newName);
  const moved = { ...entry, name: newName };
  delete reg.sessions[name];
  reg.sessions[newName] = moved;
  saveRegistry(cfg.home, reg);
  audit(cfg.home, { action: 'rename', session: newName, id: entry.id, result: 'ok' });
  return entryToSession(moved);
}

export async function openSession({ cfg, tmux, name }) {
  checkName(name);
  const { reg } = loadRegistry(cfg.home);
  const entry = getEntry(reg, name);
  if (!entry) throw new AitError(8, MSG.gone(name));
  await tmux.switchOrAttach(name);
  audit(cfg.home, { action: 'open', session: name, id: entry.id, result: 'ok' });
  return { ok: true, message: `Opened ${name}.` };
}

export async function ensureDashboard({ cfg, tmux, selfPath }) {
  const live = await tmux.listSessions();
  if (!live.some((s) => s.name === 'dash')) {
    await tmux.newSession({
      name: 'dash',
      dir: process.cwd(),
      env: { AIT_DASH_INNER: '1', AIT_HOME: cfg.home, AIT_SOCKET: cfg.socket },
      argv: [process.execPath, selfPath],
      remain: false,
    });
  }
  try { await tmux.bindReturnKey(cfg.returnKey); } catch { /* cosmetic */ }
  return { ok: true, message: 'Dashboard running.' };
}

function modesOk(home) {
  try {
    for (const p of [home, path.join(home, 'events'), path.join(home, 'settings')]) {
      let st;
      try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (!st.isDirectory() || (st.mode & 0o077)) return false;
    }
    return true;
  } catch { return false; }
}

function countJson(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

export async function doctor({ cfg, tmux, env = process.env, execFileImpl = execFile }) {
  let tv = { version: 'missing', ok: false };
  try {
    const v = await tmux.version();
    tv = { version: `${v.major}.${v.minor}`, ok: versionOk(v) };
  } catch { /* reported as missing */ }
  const cl = resolveClaude(env);
  let settingsFlagSupported = false;
  if (cl.path) {
    settingsFlagSupported = await new Promise((res) => {
      execFileImpl(cl.path, ['--help'], { timeout: 4000, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, out) => res(!err && /--settings/.test(String(out))));
    });
  }
  const prefix = tv.ok ? await tmux.prefix() : 'C-b';
  let returnKeyCollision = false;
  if (tv.ok && cfg.socket === 'default') {
    try {
      const keys = await tmux.run(['list-keys', '-T', 'prefix']);
      returnKeyCollision = new RegExp(`-T prefix\\s+${cfg.returnKey.replace(/-/g, '\\-')}\\s`).test(keys);
    } catch { returnKeyCollision = false; }
  }
  const uid = process.getuid();
  const { reg } = (() => { try { return loadRegistry(cfg.home); } catch { return { reg: { sessions: {} } }; } })();
  return {
    tmux: tv,
    claude: { path: cl.path, ok: !!cl.path, worldWritable: cl.worldWritable },
    hooks: { settingsFlagSupported, notificationKindsDistinguished: true },
    prefix,
    returnKey: cfg.returnKey,
    returnKeyCollision,
    socket: { name: cfg.socket, ownerOk: checkSocketDir(socketDir(env, uid), uid).ok },
    notifier: process.platform === 'darwin' ? 'osascript' : (process.platform === 'linux' ? 'notify-send' : 'bell-only'),
    stateDir: cfg.home,
    stateDirModesOk: modesOk(cfg.home),
    remainingState: {
      sessions: Object.keys(reg.sessions).length,
      eventFiles: countJson(path.join(cfg.home, 'events')),
      settingsFiles: countJson(path.join(cfg.home, 'settings')),
    },
  };
}

export async function exportState({ cfg }) {
  const { reg } = loadRegistry(cfg.home);
  let auditRows = [];
  try {
    auditRows = fs.readFileSync(safeFile(cfg.home, '', 'audit.log'), 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { auditRows = []; }
  return {
    exportedAt: Date.now(),
    registry: reg,
    audit: auditRows,
    settingsMetadata: Object.values(reg.sessions).map((e) => ({ session: e.name, hash: e.settingsHash || '' })),
  };
}

export async function purgeState({ cfg, tmux, confirm }) {
  if (confirm !== 'purge') throw new AitError(7, 'Type purge to confirm.', 428);
  let serverStopped = false;
  if (cfg.socket === 'default') {
    try {
      for (const s of await tmux.listSessions()) await tmux.killSession(s.name);
      serverStopped = true;
    } catch { serverStopped = false; }
  } else {
    try { await tmux.killServer(); serverStopped = true; } catch { serverStopped = false; }
  }
  const deleted = [];
  for (const f of ['registry.json', 'registry.json.bak', 'audit.log', 'audit.log.1', 'hook-errors.log', 'hook-errors.log.1', 'dashboard.lock']) {
    try {
      const p = safeFile(cfg.home, '', f);
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); deleted.push(f); }
    } catch { /* skip */ }
  }
  for (const sub of ['events', 'settings']) {
    const dir = path.join(cfg.home, sub);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (/^[a-z0-9_-]{1,24}\.json(\.[0-9a-f]{12}\.tmp)?$/.test(f)) {
        try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
      }
    }
    try { fs.rmdirSync(dir); deleted.push(`${sub}/`); } catch { /* not empty */ }
  }
  try { fs.rmdirSync(cfg.home); } catch { /* not empty or gone */ }
  return { deleted, serverStopped };
}
