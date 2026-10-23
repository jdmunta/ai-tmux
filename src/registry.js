import fs from 'node:fs';
import path from 'node:path';
import { NAME_RE, RESERVED } from './validate.js';
import { safeFile, atomicWrite } from './paths.js';

export const MAX_REGISTRY = 1024 * 1024;

export function emptyRegistry() {
  return { version: 1, nextId: 1, sessions: {} };
}

const goodName = (n) => typeof n === 'string' && NAME_RE.test(n) && !RESERVED.has(n);

function cleanEntry(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (!Number.isInteger(v.id) || v.id < 1) return null;
  if (!goodName(v.name)) return null;
  if (typeof v.dir !== 'string' || !path.isAbsolute(v.dir) || v.dir.length > 4096 || v.dir.includes('\0')) return null;
  if (!Array.isArray(v.args) || v.args.length > 32 || !v.args.every((a) => typeof a === 'string' && a.length <= 256 && !a.includes('\0'))) return null;
  if (!Number.isFinite(v.createdAt)) return null;
  const hookName = v.hookName === undefined ? v.name : v.hookName;
  if (!goodName(hookName)) return null;
  const branch = v.branch == null ? null : (typeof v.branch === 'string' && v.branch.length <= 200 ? v.branch : null);
  const csid = v.claudeSessionId == null ? null : (typeof v.claudeSessionId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(v.claudeSessionId) ? v.claudeSessionId : null);
  let exit = null;
  if (v.exit != null) {
    if (typeof v.exit !== 'object' || !Number.isInteger(v.exit.code) || !Number.isFinite(v.exit.at)) return null;
    exit = { code: v.exit.code, at: v.exit.at };
  }
  const settingsHash = typeof v.settingsHash === 'string' && /^[0-9a-f]{64}$/.test(v.settingsHash) ? v.settingsHash : null;
  return { id: v.id, name: v.name, dir: v.dir, branch, args: [...v.args], createdAt: v.createdAt, claudeSessionId: csid, exit, hookName, settingsHash };
}

export function validateRegistry(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.version !== 1 || !Number.isInteger(obj.nextId) || obj.nextId < 1) return null;
  if (!obj.sessions || typeof obj.sessions !== 'object' || Array.isArray(obj.sessions)) return null;
  const sessions = {};
  let maxId = 0;
  const ids = new Set();
  for (const [k, v] of Object.entries(obj.sessions)) {
    const e = cleanEntry(v);
    if (!e || e.name !== k || ids.has(e.id)) return null;
    ids.add(e.id);
    maxId = Math.max(maxId, e.id);
    sessions[k] = e;
  }
  return { version: 1, nextId: Math.max(obj.nextId, maxId + 1), sessions };
}

export function loadRegistry(home) {
  const file = safeFile(home, '', 'registry.json');
  let st;
  try { st = fs.statSync(file); } catch (e) {
    if (e.code === 'ENOENT') return { reg: emptyRegistry(), banner: '' };
    throw e;
  }
  let reg = null;
  if (st.size <= MAX_REGISTRY) {
    try { reg = validateRegistry(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { reg = null; }
  }
  if (reg) return { reg, banner: '' };
  try { fs.renameSync(file, `${file}.bak`); } catch { /* ignore */ }
  return { reg: emptyRegistry(), banner: 'The session registry was unreadable. A backup was saved as registry.json.bak.' };
}

export function saveRegistry(home, reg) {
  atomicWrite(safeFile(home, '', 'registry.json'), JSON.stringify(reg, null, 2));
}

export function getEntry(reg, name) {
  return Object.hasOwn(reg.sessions, name) ? reg.sessions[name] : null;
}

export function nameTaken(reg, name) {
  return Object.values(reg.sessions).some((e) => e.name === name || e.hookName === name);
}

export function addEntry(reg, fields) {
  const entry = cleanEntry({ ...fields, id: reg.nextId });
  if (!entry) throw new Error('invalid registry entry');
  reg.nextId += 1;
  reg.sessions[entry.name] = entry;
  return entry;
}

export function removeEntry(reg, name) {
  if (Object.hasOwn(reg.sessions, name)) delete reg.sessions[name];
}

export function hookNames(reg) {
  return new Set(Object.values(reg.sessions).map((e) => e.hookName));
}

// Remove event and settings files that no registry entry owns.
export function prune(home, reg) {
  const keep = hookNames(reg);
  for (const sub of ['events', 'settings']) {
    const dir = path.resolve(home, sub);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const base = f.endsWith('.json') ? f.slice(0, -5) : null;
      if (base && keep.has(base)) continue;
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
    }
  }
}
