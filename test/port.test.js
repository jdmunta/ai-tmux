import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { findFreePort, probePort } from '../src/port.js';
import { serve } from '../src/serve.js';

test('findFreePort returns the wanted port when free', async () => {
  const p = await findFreePort(0, '127.0.0.1', { probe: async (port) => port || 4321 });
  assert.equal(p, 4321);
});

test('findFreePort moves to the next port when busy (fake probe)', async () => {
  const tried = [];
  const probe = async (port) => { tried.push(port); return port === 5002 ? port : null; };
  const p = await findFreePort(5000, '0.0.0.0', { probe });
  assert.equal(p, 5002);
  assert.deepEqual(tried, [5000, 5001, 5002]);
});

test('findFreePort falls back to an OS port after maxTries', async () => {
  const probe = async (port) => (port === 0 ? 40000 : null);
  const p = await findFreePort(5000, '0.0.0.0', { probe, maxTries: 3 });
  assert.equal(p, 40000);
});

test('strict mode throws EADDRINUSE', async () => {
  await assert.rejects(
    () => findFreePort(5000, '0.0.0.0', { strict: true, probe: async () => null }),
    (e) => e.code === 'EADDRINUSE' && /already in use/.test(e.message),
  );
});

test('a really busy port is skipped', async () => {
  const blocker = net.createServer();
  blocker.listen({ port: 0, host: '0.0.0.0' });
  await once(blocker, 'listening');
  const busy = blocker.address().port;
  try {
    assert.equal(await probePort(busy, '0.0.0.0'), null);
    const p = await findFreePort(busy, '0.0.0.0');
    assert.notEqual(p, busy);
    assert.ok(p > 0);
  } finally {
    blocker.close();
  }
});

test('serve() updates PORT, logs the move and starts the server on the free port', async () => {
  const env = { PORT: '3000' };
  const logs = [];
  let started = null;
  const fake = { close() {} };
  const s = await serve({
    env,
    find: async () => 3007,
    start: ({ env: e }) => { started = e.PORT; return fake; },
    log: (m) => logs.push(m),
  });
  assert.equal(s, fake);
  assert.equal(started, '3007');
  assert.equal(env.PORT, '3007');
  assert.match(logs[0], /Port 3000 is in use\. Using port 3007 instead\./);
});

test('serve() stays quiet when the port is free and passes strict mode through', async () => {
  const logs = [];
  let strictSeen = null;
  await serve({
    env: { PORT: '3100', AIT_PORT_STRICT: '1' },
    find: async (p, h, o) => { strictSeen = o.strict; return p; },
    start: () => ({}),
    log: (m) => logs.push(m),
  });
  assert.equal(strictSeen, true);
  assert.equal(logs.length, 0);
});
