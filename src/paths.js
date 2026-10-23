import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AitError } from './errors.js';
import { NAME_RE } from './validate.js';

const SUBDIRS = ['events', 'settings'];

function refuseSymlink(p) {
  let st = null;
  try { st = fs.lstatSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && st.isSymbolicLink()) throw new AitError(7, 'State folder is a symlink; refusing to use it.');
  return st;
}

export function ensureStateDir(home) {
  const root = path.resolve(home);
  const st = refuseSymlink(root);
  if (st && !st.isDirectory()) throw new AitError(7, 'State path is not a folder.');
  if (!st) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  for (const sub of SUBDIRS) {
    const p = path.join(root, sub);
    const s2 = refuseSymlink(p);
    if (!s2) fs.mkdirSync(p, { mode: 0o700 });
    fs.chmodSync(p, 0o700);
  }
  for (const f of fs.readdirSync(root)) {
    const p = path.join(root, f);
    const s3 = fs.lstatSync(p);
    if (s3.isFile() && (s3.mode & 0o077)) fs.chmodSync(p, 0o600);
  }
  return root;
}

// The only way to build a path under the state folder.
export function safeFile(home, sub, fileName) {
  if (typeof fileName !== 'string' || fileName === '' || fileName.includes('\0')) throw new AitError(7, 'Invalid path.');
  const base = path.resolve(home, sub);
  const full = path.resolve(base, fileName);
  if (path.dirname(full) !== base || path.basename(full) !== fileName) throw new AitError(7, 'Invalid path.');
  let st = null;
  try { st = fs.lstatSync(full); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && st.isSymbolicLink()) throw new AitError(7, 'Refusing to follow a symlink in the state folder.');
  return full;
}

export function sessionFile(home, sub, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new AitError(2, 'Use letters, numbers, - and _ only.');
  return safeFile(home, sub, `${name}.json`);
}

export function atomicWrite(file, data, mode = 0o600) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx', mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}
