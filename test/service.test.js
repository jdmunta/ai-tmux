import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchSession } from '../src/launch.js';
import { listSessions, killSession, removeSession, renameSession, openSession, exportState, purgeState, getSession, doctor } from '../src/service.js';
import { ingest } from '../src/hook.js';
import { loadRegistry } from '../src/registry.js';
import { setup, fakeTmux } from './fake.js';

async function two() {
  const s = setup();
  const tmux = fakeTmux();
  await launchSession({ cfg: s.cfg, tmux, name: 'a', dir: s.proj, args: [], env: s.env });
  await launchSession({ cfg: s.cfg, tmux, name: 'b', dir: s.proj, args: [], env: s.env });
  return { s, tmux, ctx: { cfg: s.cfg, tmux, env: s.env } };
}

test('list shows hook-derived states, waiting first', async () => {
  const { s, ctx } = await two();
  ingest({ home: s.home, session: 'b', event: 'Notification', stdin: JSON.stringify({ notification_type: 'permission_prompt' }) });
  const list = await listSessions(ctx);
  assert.equal(list.sessions[0].name, 'b');
  assert.equal(list.sessions[0].state, 'waiting');
  assert.equal(list.sessions[0].kind, 'permission');
  assert.equal(list.counts.waiting, 1);
  assert.equal(list.sessions[0].args, undefined);
  const v = await listSessions(ctx, { verbose: true });
  assert.ok(Array.isArray(v.sessions[0].args));
});

test('approving a prompt (PostToolUse) returns the row to running', async () => {
  const { s, ctx } = await two();
  ingest({ home: s.home, session: 'a', event: 'Notification', stdin: '{}' });
  assert.equal((await getSession(ctx, 'a')).state, 'waiting');
  ingest({ home: s.home, session: 'a', event: 'PostToolUse', stdin: '{}' });
  assert.equal((await getSession(ctx, 'a')).state, 'running');
});

test('tmux unreachable marks the list stale instead of failing', async () => {
  const { ctx, tmux } = await two();
  tmux.listSessions = async () => { throw new Error('hung'); };
  const list = await listSessions(ctx);
  assert.equal(list.stale, true);
  assert.equal(list.sessions.length, 2);
});

test('externally killed session shows done (gone) and can be removed', async () => {
  const { ctx, tmux } = await two();
  tmux.sessions.delete('a');
  const a = await getSession(ctx, 'a');
  assert.equal(a.state, 'done');
  assert.equal(a.exit.code, -1);
  await removeSession({ ...ctx, name: 'a' });
  assert.equal(loadRegistry(ctx.cfg.home).reg.sessions.a, undefined);
});

test('rm refuses a running session; kill removes entry and files', async () => {
  const { s, ctx, tmux } = await two();
  await assert.rejects(removeSession({ ...ctx, name: 'a' }), (e) => e.status === 409);
  ingest({ home: s.home, session: 'a', event: 'Stop', stdin: '{}' });
  await killSession({ ...ctx, name: 'a' });
  assert.ok(tmux.calls.some((c) => c[0] === 'kill' && c[1] === 'a'));
  assert.equal(fs.existsSync(path.join(s.home, 'events', 'a.json')), false);
  assert.equal(fs.existsSync(path.join(s.home, 'settings', 'a.json')), false);
  await assert.rejects(killSession({ ...ctx, name: 'a' }), (e) => e.code === 8);
});

test('kill checks id and name together (SEC-REQ-14)', async () => {
  const { ctx } = await two();
  await assert.rejects(killSession({ ...ctx, name: 'a', id: 2 }), (e) => e.code === 8);
  await killSession({ ...ctx, name: 'a', id: 1 });
});

test('rename keeps the id and the hook identity', async () => {
  const { s, ctx } = await two();
  const r = await renameSession({ ...ctx, name: 'a', newName: 'alpha' });
  assert.equal(r.name, 'alpha');
  const e = loadRegistry(s.home).reg.sessions.alpha;
  assert.equal(e.id, 1);
  assert.equal(e.hookName, 'a');
  ingest({ home: s.home, session: 'a', event: 'Notification', stdin: '{}' });
  assert.equal((await getSession(ctx, 'alpha')).state, 'waiting');
  await assert.rejects(renameSession({ ...ctx, name: 'alpha', newName: 'b' }), (e2) => e2.code === 3);
  await assert.rejects(renameSession({ ...ctx, name: 'alpha', newName: 'bad name' }), (e2) => e2.code === 2);
  await assert.rejects(renameSession({ ...ctx, name: 'nope', newName: 'zz' }), (e2) => e2.code === 8);
});

test('open uses switch-or-attach and fails for unknown names', async () => {
  const { ctx, tmux } = await two();
  await openSession({ ...ctx, name: 'a' });
  assert.ok(tmux.calls.some((c) => c[0] === 'open' && c[1] === 'a'));
  await assert.rejects(openSession({ ...ctx, name: 'zzz' }), (e) => e.code === 8);
});

test('audit log records actions without free text (SEC-REQ-15)', async () => {
  const { s, ctx } = await two();
  await killSession({ ...ctx, name: 'a' });
  const rows = fs.readFileSync(path.join(s.home, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.action === 'kill' && r.session === 'a' && r.result === 'ok'));
  assert.ok(fs.statSync(path.join(s.home, 'audit.log')).mode & 0o600);
});

test('export includes registry and audit; purge needs confirmation', async () => {
  const { s, ctx, tmux } = await two();
  const doc = await exportState(ctx);
  assert.equal(Object.keys(doc.registry.sessions).length, 2);
  assert.ok(doc.audit.length >= 2);
  await assert.rejects(purgeState({ ...ctx, confirm: 'nope' }), (e) => e.status === 428);
  const res = await purgeState({ ...ctx, confirm: 'purge' });
  assert.equal(res.serverStopped, true);
  assert.ok(res.deleted.includes('registry.json'));
  assert.ok(tmux.calls.some((c) => c[0] === 'killServer'));
  assert.equal(fs.existsSync(path.join(s.home, 'registry.json')), false);
});

test('doctor reports the environment', async () => {
  const { s, ctx } = await two();
  const r = await doctor({ ...ctx, execFileImpl: (bin, args, o, cb) => cb(null, 'Usage: claude --settings <file>') });
  assert.equal(r.tmux.ok, true);
  assert.equal(r.claude.ok, true);
  assert.equal(r.hooks.settingsFlagSupported, true);
  assert.equal(r.stateDir, s.home);
  assert.equal(r.stateDirModesOk, true);
  assert.equal(r.remainingState.sessions, 2);
});

test('suggestFixes proposes commands for missing tools', async () => {
  const { suggestFixes } = await import('../src/doctor-fix.js');
  const report = {
    tmux: { version: 'missing', ok: false }, claude: { path: null, ok: false },
    hooks: { settingsFlagSupported: false }, socket: { ownerOk: true }, stateDirModesOk: true, stateDir: '/x',
  };
  const fixes = suggestFixes(report, { platform: 'darwin', has: (n) => n === 'brew' });
  assert.deepEqual(fixes.map((f) => f.command), ['brew install tmux', 'brew install --cask claude-code']);
  const none = suggestFixes({ ...report, tmux: { version: '3.8', ok: true }, claude: { path: '/c', ok: true }, hooks: { settingsFlagSupported: true } }, { has: () => false });
  assert.equal(none.length, 0);
});
