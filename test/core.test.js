import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitize } from '../src/sanitize.js';
import * as vd from '../src/validate.js';
import { sessionFile, safeFile } from '../src/paths.js';
import { loadRegistry } from '../src/registry.js';
import { ingest, readEvent, EVENTS } from '../src/hook.js';
import { resolve, createTracker, validEvent } from '../src/state.js';
import { detect } from '../src/detect-fallback.js';
import { buildNotification, osascriptArgs } from '../src/notify.js';
import { ALLOWED, target } from '../src/tmux.js';
import { lines } from '../src/render.js';
import { createUi, handleKey } from '../src/ui.js';
import { decode } from '../src/keys.js';
import { checkSocketDir } from '../src/security.js';
import { getConfig } from '../src/config.js';
import { setup } from './fake.js';

test('sanitize strips OSC, CSI, control and bidi characters', () => {
  assert.equal(sanitize('a\x1b]0;evil\x07b\x1b[31mred'), 'abred');
  assert.equal(sanitize('x\u202Ey\n\t'), 'xy');
  assert.equal(sanitize(null), '');
});

test('name validation (SEC-REQ-2)', () => {
  for (const bad of ['', '../x', 'a;b', 'a"b', 'a\0b', 'ünï', 'x'.repeat(25), 'dash', '__proto__', 'A']) {
    assert.equal(vd.name(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(vd.name('api-refactor_2').ok, true);
});

test('dir validation', () => {
  const s = setup();
  assert.equal(vd.dir(s.proj).ok, true);
  assert.equal(vd.dir(path.join(s.proj, 'nope')).code, 4);
  assert.equal(vd.dir(path.join(s.bin, 'claude')).code, 5);
});

test('paths cannot escape the state folder (SEC-REQ-3)', () => {
  const s = setup();
  assert.throws(() => sessionFile(s.home, 'events', '../x'));
  assert.throws(() => safeFile(s.home, 'events', '../x'));
  assert.throws(() => safeFile(s.home, 'events', 'a/b'));
});

test('state folder modes are private (SEC-REQ-6)', () => {
  const s = setup();
  assert.equal(fs.statSync(s.home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(s.home, 'events')).mode & 0o777, 0o700);
});

test('corrupt registry is backed up and replaced (SEC-REQ-7)', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.home, 'registry.json'), '{not json');
  const { reg, banner } = loadRegistry(s.home);
  assert.deepEqual(reg.sessions, {});
  assert.match(banner, /unreadable/);
  assert.ok(fs.existsSync(path.join(s.home, 'registry.json.bak')));
});

test('hook ingest rejects traversal and unknown events', () => {
  const s = setup();
  assert.equal(ingest({ home: s.home, session: '../../evil', event: 'Stop' }).accepted, false);
  assert.equal(ingest({ home: s.home, session: 'ok', event: 'Nope' }).accepted, false);
  assert.equal(ingest({ home: s.home, session: 'ok', event: 'Notification', stdin: JSON.stringify({ notification_type: 'permission_prompt', session_id: 'abc-1' }) }).accepted, true);
  const ev = readEvent(s.home, 'ok');
  assert.equal(ev.kind, 'permission');
  assert.equal(ev.claudeSessionId, 'abc-1');
  assert.ok(EVENTS.includes('PostToolUse') && EVENTS.includes('PreToolUse'));
});

test('hook ignores oversized payloads but still records the event', () => {
  const s = setup();
  const r = ingest({ home: s.home, session: 'big', event: 'Stop', stdin: 'x'.repeat(70000) });
  assert.equal(r.accepted, true);
  assert.equal(readEvent(s.home, 'big').event, 'Stop');
});

const entry = { name: 'a', hookName: 'a', createdAt: 1000, exit: null };
const alive = { name: 'a', attached: 0, dead: false, deadStatus: null };

test('state: event mapping, including tool-finished returning to running', () => {
  const now = 100000;
  const ev = (event, kind = null, ts = 50000) => ({ session: 'a', event, kind, ts, claudeSessionId: null });
  assert.equal(resolve({ entry, info: alive, event: ev('Notification', 'permission'), now }).state, 'waiting');
  assert.equal(resolve({ entry, info: alive, event: ev('Notification', 'idle'), now }).state, 'idle');
  assert.equal(resolve({ entry, info: alive, event: ev('Stop'), now }).state, 'idle');
  assert.equal(resolve({ entry, info: alive, event: ev('PostToolUse'), now }).state, 'running');
  assert.equal(resolve({ entry, info: alive, event: ev('UserPromptSubmit'), now }).state, 'running');
});

test('state: forged and stale events are ignored (SEC-REQ-8)', () => {
  const now = 100000;
  const future = { session: 'a', event: 'Stop', kind: null, ts: now + 60000, claudeSessionId: null };
  const old = { session: 'a', event: 'Stop', kind: null, ts: 10, claudeSessionId: null };
  const other = { session: 'b', event: 'Stop', kind: null, ts: 50000, claudeSessionId: null };
  for (const e of [future, old, other]) assert.equal(validEvent(e, entry, now), false);
  assert.equal(resolve({ entry, info: alive, event: future, capture: 'esc to interrupt', now }).source, 'fallback');
});

test('state: dead pane is done with exit code; grace period is running', () => {
  const dead = { name: 'a', attached: 0, dead: true, deadStatus: 2 };
  const r = resolve({ entry, info: dead, now: 5000 });
  assert.equal(r.state, 'done');
  assert.equal(r.exit.code, 2);
  assert.equal(resolve({ entry, info: alive, now: 3000 }).state, 'running');
  assert.equal(resolve({ entry, info: null, stale: true, now: 5000 }).state, 'unknown');
});

test('tracker debounces and notifies once per transition', () => {
  const t = createTracker({ debounceMs: 500 });
  const item = (state, attached = false) => [{ name: 'a', state, since: 0, attached }];
  t.update(item('running'), 0);
  assert.equal(t.update(item('waiting'), 100).transitions.length, 0);
  assert.equal(t.update(item('running'), 300).transitions.length, 0);
  t.update(item('waiting'), 1000);
  const r = t.update(item('waiting'), 1600);
  assert.deepEqual(r.transitions, [{ name: 'a', from: 'running', to: 'waiting' }]);
  assert.equal(t.update(item('waiting'), 2200).transitions.length, 0);
});

test('tracker does not notify for an attached session', () => {
  const t = createTracker({ debounceMs: 500 });
  t.update([{ name: 'a', state: 'running', since: 0, attached: true }], 0);
  t.update([{ name: 'a', state: 'waiting', since: 0, attached: true }], 100);
  assert.equal(t.update([{ name: 'a', state: 'waiting', since: 0, attached: true }], 700).transitions.length, 0);
});

test('fallback detection biases to waiting', () => {
  assert.equal(detect('Do you want to proceed?\n❯ 1. Yes').state, 'waiting');
  assert.equal(detect('working... esc to interrupt').state, 'running');
  assert.equal(detect('Do you want to proceed?\nesc to interrupt').state, 'waiting');
  assert.equal(detect('? for shortcuts').state, 'idle');
  assert.equal(detect('???').state, 'unknown');
});

test('notifications: coalescing, idle opt-in, argv-only AppleScript (SEC-REQ-5)', () => {
  const w = (name) => ({ name, from: 'running', to: 'waiting' });
  assert.equal(buildNotification([w('a'), w('b'), w('c')]).title, '3 sessions are waiting');
  assert.equal(buildNotification([{ name: 'a', from: 'running', to: 'idle' }], {}), null);
  assert.ok(buildNotification([{ name: 'a', from: 'running', to: 'idle' }], { notifyIdle: true }));
  const evil = 'x" & do shell script "id" & "';
  const args = osascriptArgs(evil, '$(id)\n');
  assert.equal(args[args.length - 2], evil);
  assert.ok(!args.slice(0, -2).join(' ').includes('do shell script'));
});

test('tmux allowlist and exact targets (SEC-REQ-13)', () => {
  for (const bad of ['send-keys', 'paste-buffer', 'run-shell', 'pipe-pane']) assert.equal(ALLOWED.has(bad), false);
  assert.equal(target('api'), '=ait-api');
  assert.throws(() => target('a;b'));
});

function walk(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...walk(p));
    else if (f.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('static scan: no shell execution, no forbidden tmux commands (SEC-REQ-4, SEC-REQ-13)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'bin'))];
  assert.ok(files.length > 10);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/\{[^}]*\bexec\b[^}]*\}\s*from\s*'node:child_process'/.test(text), `exec import in ${f}`);
    assert.ok(!/\bexecSync\b|\bspawnSync\b|shell\s*:\s*true/.test(text), `shell use in ${f}`);
    assert.ok(!/send-keys|paste-buffer|run-shell|pipe-pane/.test(text), `forbidden tmux command in ${f}`);
    if (!/server\.js$|port\.js$/.test(f)) {
      assert.ok(!/node:https?'|\bfetch\(/.test(text), `network API in ${f}`);
    }
  }
});

test('render: 24 rows, highlights waiting, ASCII mode, sanitizes names', () => {
  const sessions = [
    { id: 1, name: 'api', dir: '/x/api', state: 'waiting', since: 0, exit: null },
    { id: 2, name: 'evil\x1b[31m', dir: '/x/b', state: 'running', since: 0, exit: null },
    { id: 3, name: 'old', dir: '/x/c', state: 'done', since: 0, exit: { code: 2, at: 0 } },
  ];
  const out = lines({ sessions, selected: 'api' }, { cols: 80, rows: 24, now: 1000 });
  assert.equal(out.length, 24);
  assert.ok(out.some((l) => l.includes('WAITING')));
  assert.ok(out.some((l) => l.includes('(exit 2)')));
  assert.ok(!out.join('\n').includes('\x1b[31m' + 'evil'));
  const ascii = lines({ sessions, selected: 'api' }, { cols: 80, rows: 24, ascii: true });
  assert.ok(ascii.some((l) => l.includes('!')));
  assert.equal(lines({ sessions }, { cols: 50, rows: 10 })[0].startsWith('Terminal too small'), true);
});

test('ui: numbers are stable ids, kill needs y, dialogs trap keys', () => {
  const ui = createUi('/tmp');
  const list = [
    { id: 5, name: 'e', state: 'running', since: 0 },
    { id: 2, name: 'b', state: 'waiting', since: 0 },
  ];
  ui.selected = 'e';
  assert.deepEqual(handleKey(ui, '2', list), { type: 'open', name: 'b', id: 2 });
  assert.equal(ui.selected, 'b');
  // opening by number moved the selection; go back to 'e' before the kill checks
  ui.selected = 'e';
  handleKey(ui, 'x', list);
  assert.equal(ui.mode, 'kill');
  assert.equal(handleKey(ui, 'enter', list), null);
  assert.equal(ui.mode, 'list');
  handleKey(ui, 'x', list);
  assert.deepEqual(handleKey(ui, 'y', list), { type: 'kill', name: 'e', id: 5 });
  handleKey(ui, 'n', list);
  assert.equal(ui.mode, 'new');
  assert.equal(handleKey(ui, 'q', list), null);
  assert.equal(ui.fields.name, 'q');
  assert.equal(handleKey(ui, 'esc', list), null);
  assert.equal(handleKey(ui, 'q', list).type, 'quit');
});

test('ui: w jumps to next waiting session', () => {
  const ui = createUi('/tmp');
  const list = [
    { id: 1, name: 'a', state: 'running', since: 0 },
    { id: 2, name: 'b', state: 'idle', since: 0 },
    { id: 3, name: 'c', state: 'waiting', since: 0 },
  ];
  ui.selected = 'a';
  handleKey(ui, 'w', list);
  assert.equal(ui.selected, 'c');
});

test('keys decode arrows, enter, escape', () => {
  assert.deepEqual(decode('\x1b[A\x1b[B\r\x1b'), ['up', 'down', 'enter', 'esc']);
  assert.deepEqual(decode('j\x03'), ['j', 'ctrl-c']);
});

test('socket folder check refuses group/world access (SEC-REQ-1)', () => {
  const s = setup();
  const d = path.join(s.root, 'sock');
  fs.mkdirSync(d);
  fs.chmodSync(d, 0o755);
  assert.equal(checkSocketDir(d, process.getuid()).ok, false);
  fs.chmodSync(d, 0o700);
  assert.equal(checkSocketDir(d, process.getuid()).ok, true);
});

test('config: invalid PORT falls back to 3000; socket name validated', () => {
  assert.equal(getConfig({ PORT: 'abc' }).port, 3000);
  assert.equal(getConfig({ PORT: '8080' }).port, 8080);
  assert.equal(getConfig({ AIT_SOCKET: 'a/b' }).socket, 'ait');
});
