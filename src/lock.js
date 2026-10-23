import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { safeFile, atomicWrite } from './paths.js';

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function commandOf(pid, execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl('ps', ['-p', String(pid), '-o', 'command='], { timeout: 2000, maxBuffer: 1 << 16 }, (err, out) => resolve(err ? '' : String(out)));
  });
}

// The lock is trusted only when its PID is alive and that process looks like ait.
export async function acquireLock(home, { pid = process.pid, execFileImpl = execFile } = {}) {
  const file = safeFile(home, '', 'dashboard.lock');
  let other = null;
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (/^\d{1,10}$/.test(text)) other = Number(text);
  } catch { /* no lock yet */ }
  if (other && other !== pid && isAlive(other)) {
    const cmd = await commandOf(other, execFileImpl);
    if (/ait/.test(cmd)) return { ok: false, pid: other };
  }
  atomicWrite(file, String(pid));
  return {
    ok: true,
    release() {
      try {
        if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.rmSync(file, { force: true });
      } catch { /* already gone */ }
    },
  };
}
