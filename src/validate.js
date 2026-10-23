import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MSG } from './errors.js';

export const NAME_RE = /^[a-z0-9_-]{1,24}$/;
export const RESERVED = new Set(['dash', '__proto__']);

export function name(s) {
  if (typeof s !== 'string' || s.length === 0) return { ok: false, error: MSG.nameEmpty, code: 2 };
  if (!NAME_RE.test(s)) return { ok: false, error: MSG.nameInvalid, code: 2 };
  if (RESERVED.has(s)) return { ok: false, error: MSG.nameReserved, code: 2 };
  return { ok: true };
}

export function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

export function dir(s, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const input = typeof s === 'string' && s.trim() ? s.trim() : cwd;
  if (input.includes('\0')) return { ok: false, error: MSG.dirMissing, code: 4 };
  const abs = path.resolve(cwd, expandHome(input, home));
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, error: MSG.dirMissing, code: 4 }; }
  if (!st.isDirectory()) return { ok: false, error: MSG.dirFile, code: 5 };
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* keep abs */ }
  return { ok: true, path: real };
}
