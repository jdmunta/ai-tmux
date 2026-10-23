import { detect } from './detect-fallback.js';

export const GRACE_MS = 10000;
export const FUTURE_SKEW_MS = 5000;

export function mapEvent(ev) {
  switch (ev.event) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return { state: 'running', kind: null };
    case 'Notification':
      return ev.kind === 'idle' ? { state: 'idle', kind: 'idle' } : { state: 'waiting', kind: ev.kind || 'question' };
    case 'Stop':
      return { state: 'idle', kind: null };
    default:
      return null;
  }
}

// SEC-REQ-8: drop events for another session, older than the session, or from the future.
export function validEvent(ev, entry, now) {
  return !!ev && ev.session === entry.hookName && ev.ts >= entry.createdAt && ev.ts <= now + FUTURE_SKEW_MS;
}

export function needsCapture({ entry, info, event, now }) {
  return !!info && !info.dead && !validEvent(event, entry, now) && now - entry.createdAt >= GRACE_MS;
}

export function resolve({ entry, info, stale = false, event = null, capture = null, now = Date.now() }) {
  const alive = !!info && !info.dead;
  if (!alive) {
    if (entry.exit) return { state: 'done', kind: null, since: entry.exit.at, source: 'hook', degraded: false, exit: entry.exit };
    if (info && info.dead) {
      return { state: 'done', kind: null, since: now, source: 'hook', degraded: false, exit: { code: info.deadStatus ?? 0, at: now } };
    }
    if (stale) return { state: 'unknown', kind: null, since: entry.createdAt, source: 'hook', degraded: false, exit: null };
    return { state: 'done', kind: null, since: now, source: 'hook', degraded: false, exit: { code: -1, at: now } };
  }
  if (validEvent(event, entry, now)) {
    const m = mapEvent(event);
    return { state: m.state, kind: m.kind, since: Math.min(event.ts, now), source: 'hook', degraded: false, exit: null };
  }
  if (now - entry.createdAt < GRACE_MS) {
    return { state: 'running', kind: null, since: entry.createdAt, source: 'hook', degraded: false, exit: null };
  }
  if (capture == null) {
    return { state: 'unknown', kind: null, since: entry.createdAt, source: 'fallback', degraded: true, exit: null };
  }
  return { state: detect(capture).state, kind: null, since: now, source: 'fallback', degraded: true, exit: null };
}

// Debounce: a state is shown (and notified) only after it held for debounceMs.
// A waiting state that clears inside the window never produces a transition.
export function createTracker({ debounceMs = 500 } = {}) {
  const m = new Map();
  return {
    update(items, now = Date.now()) {
      const seen = new Set();
      const transitions = [];
      const shown = new Map();
      for (const it of items) {
        seen.add(it.name);
        let t = m.get(it.name);
        if (!t) {
          t = { state: it.state, since: it.since, cand: it.state, candSince: now };
          m.set(it.name, t);
        } else if (it.state === t.state) {
          t.cand = t.state;
          t.candSince = now;
        } else if (it.state !== t.cand) {
          t.cand = it.state;
          t.candSince = now;
        } else if (now - t.candSince >= debounceMs) {
          const from = t.state;
          t.state = it.state;
          t.since = it.since ?? now;
          t.cand = t.state;
          t.candSince = now;
          if (!it.attached) transitions.push({ name: it.name, from, to: t.state });
        }
        shown.set(it.name, { state: t.state, since: t.since });
      }
      for (const k of [...m.keys()]) if (!seen.has(k)) m.delete(k);
      return { shown, transitions };
    },
  };
}
