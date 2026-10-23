import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchSession, checkArgs, projectHooks, resolveClaude } from '../src/launch.js';
import { loadRegistry } from '../src/registry.js';
import { EVENTS } from '../src/hook.js';
import { AitError } from '../src/errors.js';
import { setup, fakeTmux } from './fake.js';

const base = (s, tmux, extra = {}) => ({ cfg: s.cfg, tmux, name: 'api', dir: s.proj, args: [], env: s.env, ...extra });

test('launch registers the session, writes private hook settings and starts tmux', async () => {
  const s = setup();
  const tmux = fakeTmux();
  const r = await launchSession(base(s, tmux, { args: ['--model', 'sonnet'] }));
  assert.equal(r.entry.id, 1);
  assert.ok(loadRegistry(s.home).reg.sessions.api);
  const file = path.join(s.home, 'settings', 'api.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(j.hooks).sort(), [...EVENTS].sort());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const call = tmux.calls[0];
  assert.equal(call[1], 'api');
  const opts = call[2];
  assert.equal(opts.env.AIT_SESSION, 'api');
  assert.ok(opts.argv[0].endsWith('claude'));
  assert.deepEqual(opts.argv.slice(1), ['--settings', file, '--model', 'sonnet']);
});

test('ids are never reused', async () => {
  const s = setup();
  const tmux = fakeTmux();
  await launchSession(base(s, tmux, { name: 'one' }));
  const r2 = await launchSession(base(s, tmux, { name: 'two' }));
  assert.equal(r2.entry.id, 2);
});

test('invalid name, taken name, missing dir, file instead of dir', async () => {
  const s = setup();
  const tmux = fakeTmux();
  await assert.rejects(launchSession(base(s, tmux, { name: 'a;b' })), (e) => e.code === 2);
  await launchSession(base(s, tmux));
  await assert.rejects(launchSession(base(s, tmux)), (e) => e.code === 3);
  await assert.rejects(launchSession(base(s, tmux, { name: 'x', dir: path.join(s.proj, 'nope') })), (e) => e.code === 4);
  await assert.rejects(launchSession(base(s, tmux, { name: 'y', dir: path.join(s.bin, 'claude') })), (e) => e.code === 5);
});

test('claude missing gives exit 6', async () => {
  const s = setup();
  await assert.rejects(launchSession(base(s, fakeTmux(), { env: { ...s.env, PATH: '/nonexistent-dir' } })), (e) => e.code === 6);
});

test('resolveClaude ignores relative PATH entries', () => {
  const s = setup();
  assert.equal(resolveClaude({ PATH: `.:${s.bin}` }).path, fs.realpathSync(path.join(s.bin, 'claude')));
  assert.equal(resolveClaude({ PATH: '.:bin' }).path, null);
});

test('resolveClaude refuses a world-writable folder', () => {
  const s = setup();
  fs.chmodSync(s.bin, 0o777);
  const r = resolveClaude({ PATH: s.bin });
  assert.equal(r.path, null);
  assert.equal(r.worldWritable, true);
});

test('project hooks need confirmation and fail closed (SEC-REQ-11)', async () => {
  const s = setup();
  fs.mkdirSync(path.join(s.proj, '.claude'));
  const f = path.join(s.proj, '.claude', 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ hooks: { Stop: [] } }));
  const tmux = fakeTmux();
  await assert.rejects(launchSession(base(s, tmux)), (e) => e instanceof AitError && e.needsConfirm && e.status === 428);
  assert.equal(tmux.calls.length, 0);
  await launchSession(base(s, tmux, { confirmProjectHooks: true }));
  assert.equal(tmux.calls.length, 1);
});

test('unparseable or oversized project settings count as hooks', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.proj, '.claude'));
  const f = path.join(s.proj, '.claude', 'settings.json');
  fs.writeFileSync(f, '{broken');
  assert.equal(projectHooks(s.proj), true);
  fs.writeFileSync(f, JSON.stringify({ pad: 'x'.repeat(1100000) }));
  assert.equal(projectHooks(s.proj), true);
  fs.writeFileSync(f, JSON.stringify({ permissions: {} }));
  assert.equal(projectHooks(s.proj), false);
});

test('user-supplied --settings is rejected; dangerous flags need confirmation', async () => {
  assert.throws(() => checkArgs(['--settings', 'x.json']), (e) => e.code === 2);
  assert.throws(() => checkArgs(['--settings=x.json']), (e) => e.code === 2);
  assert.equal(checkArgs(['--dangerously-skip-permissions']).dangerous, true);
  assert.equal(checkArgs(['--permission-mode', 'bypassPermissions']).dangerous, true);
  assert.equal(checkArgs(['--model', 'sonnet']).dangerous, false);
  const s = setup();
  const tmux = fakeTmux();
  await assert.rejects(launchSession(base(s, tmux, { args: ['--dangerously-skip-permissions'] })), (e) => e.needsConfirm === true);
  assert.equal(tmux.calls.length, 0);
  await launchSession(base(s, tmux, { args: ['--dangerously-skip-permissions'], confirmDangerousArgs: true }));
  assert.equal(tmux.calls.length, 1);
});

test('failed tmux start rolls back registry and settings', async () => {
  const s = setup();
  const tmux = fakeTmux();
  tmux.newSession = async () => { throw new AitError(7, 'boom'); };
  await assert.rejects(launchSession(base(s, tmux)), (e) => e.code === 7);
  assert.deepEqual(loadRegistry(s.home).reg.sessions, {});
  assert.equal(fs.existsSync(path.join(s.home, 'settings', 'api.json')), false);
});
