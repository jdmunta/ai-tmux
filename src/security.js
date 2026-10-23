import fs from 'node:fs';
import path from 'node:path';
import { AitError } from './errors.js';

export function socketDir(env = process.env, uid = process.getuid()) {
  return path.join(env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`);
}

export function checkSocketDir(dir, uid) {
  let st;
  try { st = fs.lstatSync(dir); } catch (e) {
    if (e.code === 'ENOENT') return { ok: true };
    return { ok: false, reason: 'unreadable' };
  }
  if (!st.isDirectory()) return { ok: false, reason: 'not a folder' };
  if (st.uid !== uid) return { ok: false, reason: 'owned by another user' };
  if (st.mode & 0o077) return { ok: false, reason: 'group or world access' };
  return { ok: true };
}

export function assertSocketSafe(env = process.env) {
  const uid = process.getuid();
  const r = checkSocketDir(socketDir(env, uid), uid);
  if (!r.ok) {
    throw new AitError(7, `The tmux socket folder is not private (${r.reason}). Fix its permissions (chmod 700) and try again.`);
  }
}
