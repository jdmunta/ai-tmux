import fs from 'node:fs';
import { safeFile } from './paths.js';
import { sanitize } from './sanitize.js';

const MAX_LOG = 1024 * 1024;

export function appendLog(home, fileName, line) {
  try {
    const file = safeFile(home, '', fileName);
    try {
      if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, `${file}.1`);
    } catch { /* no file yet */ }
    fs.appendFileSync(file, line + '\n', { mode: 0o600 });
  } catch { /* logging must never break the tool */ }
}

export function audit(home, { action, session, id = 0, result = 'ok' }) {
  appendLog(home, 'audit.log', JSON.stringify({ ts: Date.now(), action, session: sanitize(session).slice(0, 24), id, result }));
}
