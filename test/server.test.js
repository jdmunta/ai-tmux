import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { startServer } from '../src/server.js';
import { probePort } from '../src/port.js';
import { setup, fakeTmux } from './fake.js';

function call(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

async function boot(extraEnv = {}) {
  const s = setup();
  const port = await probePort(0, '0.0.0.0');
  const env = { ...s.env, PORT: String(port), ...extraEnv };
  const server = startServer({ env, tmux: fakeTmux(), log: () => {} });
  await once(server, 'listening');
  return { s, port, server, close: () => { server.closeAllConnections(); server.close(); } };
}

const JSON_H = { 'Content-Type': 'application/json' };

test('GET /health is 200 without any credentials', async () => {
  const b = await boot({ AIT_API_TOKEN: 'secret-token-123' });
  try {
    const r = await call(b.port, { url: '/health', headers: { Host: 'anything.example' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'ok' });
  } finally { b.close(); }
});

test('loopback client can list sessions; empty list is normal', async () => {
  const b = await boot();
  try {
    const r = await call(b.port, { url: '/sessions' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sessions, []);
    assert.equal(r.body.counts.waiting, 0);
  } finally { b.close(); }
});

test('DNS-rebinding style Host and any Origin are refused', async () => {
  const b = await boot();
  try {
    assert.equal((await call(b.port, { url: '/sessions', headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await call(b.port, { url: '/sessions', headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call(b.port, { url: '/export', headers: { Origin: 'http://localhost' } })).status, 403);
  } finally { b.close(); }
});

test('denied requests are written to the audit log', async () => {
  const b = await boot();
  try {
    await call(b.port, { url: '/sessions', headers: { Origin: 'http://evil.example' } });
    const log = fs.readFileSync(path.join(b.s.home, 'audit.log'), 'utf8');
    assert.match(log, /"result":"denied"/);
  } finally { b.close(); }
});

test('token mode: 401 without or with a wrong token, 200 with the right one', async () => {
  const b = await boot({ AIT_API_TOKEN: 'secret-token-123' });
  try {
    assert.equal((await call(b.port, { url: '/sessions' })).status, 401);
    assert.equal((await call(b.port, { url: '/sessions', headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await call(b.port, { url: '/sessions', headers: { Authorization: 'Bearer secret-token-123' } })).status, 200);
  } finally { b.close(); }
});

test('POST routes with a body require application/json', async () => {
  const b = await boot();
  try {
    const bad = await call(b.port, { method: 'POST', url: '/sessions', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"x"}' });
    assert.equal(bad.status, 415);
    const purge = await call(b.port, { method: 'POST', url: '/purge', headers: { 'Content-Type': 'text/plain' }, body: '{"confirm":"purge"}' });
    assert.equal(purge.status, 415);
    assert.equal(fs.existsSync(b.s.home), true);
  } finally { b.close(); }
});

test('create, get, rename, kill over HTTP', async () => {
  const b = await boot();
  try {
    const created = await call(b.port, { method: 'POST', url: '/sessions', headers: JSON_H, body: JSON.stringify({ name: 'api', dir: b.s.proj }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'api');
    assert.equal(created.body.id, 1);

    const dup = await call(b.port, { method: 'POST', url: '/sessions', headers: JSON_H, body: JSON.stringify({ name: 'api', dir: b.s.proj }) });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 3);

    const bad = await call(b.port, { method: 'POST', url: '/sessions', headers: JSON_H, body: JSON.stringify({ name: 'a;b' }) });
    assert.equal(bad.status, 400);

    const extra = await call(b.port, { method: 'POST', url: '/sessions', headers: JSON_H, body: JSON.stringify({ name: 'zz', evil: 1 }) });
    assert.equal(extra.status, 400);

    const got = await call(b.port, { url: '/sessions/api' });
    assert.equal(got.status, 200);

    const ren = await call(b.port, { method: 'PATCH', url: '/sessions/api', headers: JSON_H, body: JSON.stringify({ name: 'api2' }) });
    assert.equal(ren.status, 200);
    assert.equal(ren.body.name, 'api2');

    const noConfirm = await call(b.port, { method: 'DELETE', url: '/sessions/api2' });
    assert.equal(noConfirm.status, 428);
    const killed = await call(b.port, { method: 'DELETE', url: '/sessions/api2?confirm=true' });
    assert.equal(killed.status, 200);
    assert.equal(killed.body.ok, true);
    assert.equal((await call(b.port, { url: '/sessions/api2' })).status, 404);
  } finally { b.close(); }
});

test('dangerous args over HTTP are not silently accepted', async () => {
  const b = await boot();
  try {
    const r = await call(b.port, { method: 'POST', url: '/sessions', headers: JSON_H, body: JSON.stringify({ name: 'x1', dir: b.s.proj, args: ['--settings', 'evil.json'] }) });
    assert.equal(r.status, 400);
    const d = await call(b.port, { method: 'POST', url: '/sessions', headers: JSON_H, body: JSON.stringify({ name: 'x2', dir: b.s.proj, args: ['--dangerously-skip-permissions'] }) });
    assert.equal(d.status, 428);
  } finally { b.close(); }
});

test('hook route stores events and drops traversal attempts', async () => {
  const b = await boot();
  try {
    const ok = await call(b.port, { method: 'POST', url: '/hooks/Stop', headers: { ...JSON_H, AIT_SESSION: 'sess1' }, body: '{}' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.accepted, true);
    assert.ok(fs.existsSync(path.join(b.s.home, 'events', 'sess1.json')));
    const evil = await call(b.port, { method: 'POST', url: '/hooks/Stop', headers: { ...JSON_H, AIT_SESSION: '../../x' }, body: '{}' });
    assert.equal(evil.status, 200);
    assert.equal(evil.body.accepted, false);
    assert.equal((await call(b.port, { method: 'POST', url: '/hooks/Bogus', headers: { AIT_SESSION: 'sess1' } })).status, 400);
  } finally { b.close(); }
});

test('purge needs the typed confirmation; unknown routes are 404', async () => {
  const b = await boot();
  try {
    const wrong = await call(b.port, { method: 'POST', url: '/purge', headers: JSON_H, body: JSON.stringify({ confirm: 'yes' }) });
    assert.equal(wrong.status, 428);
    assert.equal((await call(b.port, { url: '/nope' })).status, 404);
    const doc = await call(b.port, { url: '/doctor' });
    assert.equal(doc.status, 200);
    assert.equal(doc.body.stateDir, b.s.home);
  } finally { b.close(); }
});
