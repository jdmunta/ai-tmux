import fs from 'node:fs';
import { NAME_RE } from './validate.js';
import { ensureStateDir, sessionFile, atomicWrite } from './paths.js';
import { getConfig } from './config.js';
import { appendLog } from './audit.js';
import { sanitize } from './sanitize.js';

export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
export const MAX_STDIN = 64 * 1024;
const KINDS = new Set(['permission', 'question', 'idle']);

// Distinguish idle prompt from permission prompt; unknown notifications err on the side of "waiting".
export function classifyKind(payload) {
  const t = String(payload.notification_type || '').toLowerCase();
  const m = String(payload.message || '');
  if (t === 'idle_prompt' || /waiting for your input/i.test(m)) return 'idle';
  if (t.startsWith('permission') || /permission/i.test(m)) return 'permission';
  return 'question';
}

export function ingest({ home, session, event, stdin = '', now = Date.now() }) {
  if (typeof session !== 'string' || !NAME_RE.test(session)) return { accepted: false, reason: 'bad-session' };
  if (!EVENTS.includes(event)) return { accepted: false, reason: 'bad-event' };
  let payload = {};
  if (stdin.length <= MAX_STDIN) {
    try {
      const o = JSON.parse(stdin || '{}');
      if (o && typeof o === 'object' && !Array.isArray(o)) payload = o;
    } catch { /* ignore malformed payload */ }
  }
  const sid = typeof payload.session_id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(payload.session_id) ? payload.session_id : null;
  const rec = {
    session,
    event,
    kind: event === 'Notification' ? classifyKind(payload) : null,
    ts: now,
    claudeSessionId: sid,
  };
  ensureStateDir(home);
  atomicWrite(sessionFile(home, 'events', session), JSON.stringify(rec));
  return { accepted: true };
}

export function cleanEvent(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.session !== 'string' || !NAME_RE.test(o.session)) return null;
  if (!EVENTS.includes(o.event)) return null;
  if (o.kind !== null && !KINDS.has(o.kind)) return null;
  if (!Number.isFinite(o.ts)) return null;
  const sid = typeof o.claudeSessionId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(o.claudeSessionId) ? o.claudeSessionId : null;
  return { session: o.session, event: o.event, kind: o.kind, ts: o.ts, claudeSessionId: sid };
}

export function readEvent(home, hookName) {
  try {
    const file = sessionFile(home, 'events', hookName);
    if (fs.statSync(file).size > MAX_STDIN) return null;
    return cleanEvent(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export async function runHookFromStdin(event, env = process.env, stdin = process.stdin) {
  const cfg = getConfig(env);
  try {
    let text = '';
    let total = 0;
    let over = false;
    if (!stdin.isTTY) {
      for await (const chunk of stdin) {
        total += chunk.length;
        if (total > MAX_STDIN) { over = true; break; }
        text += chunk.toString('utf8');
      }
    }
    ingest({ home: cfg.home, session: env.AIT_SESSION, event, stdin: over ? 'x'.repeat(MAX_STDIN + 1) : text });
  } catch (e) {
    appendLog(cfg.home, 'hook-errors.log', `${new Date().toISOString()} hook error: ${sanitize(e && e.message).slice(0, 200)}`);
  }
}
