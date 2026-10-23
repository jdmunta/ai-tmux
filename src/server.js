import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { AitError, MSG } from './errors.js';
import { createTmux, versionOk } from './tmux.js';
import { assertSocketSafe } from './security.js';
import { ensureStateDir } from './paths.js';
import { NAME_RE } from './validate.js';
import { audit } from './audit.js';
import { ingest, EVENTS } from './hook.js';
import { launchSession } from './launch.js';
import {
  listSessions, getSession, killSession, removeSession, renameSession, openSession,
  ensureDashboard, doctor, exportState, purgeState, entryToSession,
} from './service.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_BODY = 64 * 1024;

export function statusFor(e) {
  if (e.status) return e.status;
  if (e.needsConfirm) return 428;
  switch (e.code) {
    case 2: return 400;
    case 3: return 409;
    case 4: case 5: return 422;
    case 6: return 424;
    case 7: return 502;
    case 8: return 404;
    case 10: return 503;
    default: return 500;
  }
}

function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(String(header || ''));
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  let total = 0;
  const chunks = [];
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY) throw new AitError(7, 'Request body is too large.', 413);
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function onlyKeys(o, allowed) {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new AitError(2, `Unknown field: ${k.slice(0, 40)}`, 400);
  }
}

export function startServer({ env = process.env, tmux: injected = null, log = (m) => process.stdout.write(`${m}\n`) } = {}) {
  const cfg = getConfig(env);
  const tmux = injected || createTmux(cfg, { env });
  const selfPath = fileURLToPath(new URL('../bin/ait.js', import.meta.url));
  const ctx = { cfg, tmux, env };
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

  function guard(req) {
    if (req.headers.origin !== undefined) throw new AitError(7, 'Cross-origin requests are not allowed.', 403);
    if (cfg.apiToken) {
      if (!tokenOk(req.headers.authorization, cfg.apiToken)) throw new AitError(7, 'Missing or wrong token.', 401);
      return;
    }
    if (!LOOPBACK.has(req.socket.remoteAddress)) {
      throw new AitError(7, 'Only local requests are accepted. Set AIT_API_TOKEN to allow others.', 403);
    }
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!HOSTS.has(host)) throw new AitError(7, 'Unexpected Host header.', 403);
  }

  async function prepare() {
    if (!injected) {
      const v = await tmux.version();
      if (!versionOk(v)) throw new AitError(10, MSG.tmuxMissing);
      assertSocketSafe(env);
    }
    ensureStateDir(cfg.home);
  }

  async function jsonBody(req) {
    const raw = await readBody(req);
    if (!raw) throw new AitError(2, 'A JSON body is required.', 400);
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      throw new AitError(2, 'Content-Type must be application/json.', 415);
    }
    let o;
    try {
      o = JSON.parse(raw);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('shape');
    } catch { throw new AitError(2, 'Invalid JSON body.', 400); }
    return o;
  }

  function send(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
  }

  async function route(req, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const m = req.method;
    const verbose = url.searchParams.get('verbose') === 'true';
    const [root, rawName, sub] = parts;

    if (root === 'sessions' && parts.length === 1) {
      if (m === 'GET') { await prepare(); return [200, await listSessions(ctx, { verbose })]; }
      if (m === 'POST') {
        const b = await jsonBody(req);
        onlyKeys(b, ['name', 'dir', 'args', 'confirmProjectHooks']);
        if (typeof b.name !== 'string') throw new AitError(2, MSG.nameEmpty, 400);
        if (b.dir !== undefined && typeof b.dir !== 'string') throw new AitError(4, MSG.dirMissing, 422);
        if (b.args !== undefined && (!Array.isArray(b.args) || !b.args.every((a) => typeof a === 'string'))) {
          throw new AitError(2, 'args must be a list of strings.', 400);
        }
        return serial(async () => {
          await prepare();
          const r = await launchSession({
            cfg, tmux, name: b.name, dir: b.dir, args: b.args || [],
            confirmProjectHooks: b.confirmProjectHooks === true, env,
          });
          return [201, entryToSession(r.entry)];
        });
      }
    }

    if (root === 'sessions' && parts.length >= 2) {
      let name;
      try { name = decodeURIComponent(rawName); } catch { throw new AitError(2, MSG.nameInvalid, 400); }
      if (!NAME_RE.test(name)) throw new AitError(2, MSG.nameInvalid, 400);

      if (parts.length === 2) {
        if (m === 'GET') { await prepare(); return [200, await getSession(ctx, name, { verbose })]; }
        if (m === 'PATCH') {
          const b = await jsonBody(req);
          onlyKeys(b, ['name']);
          if (typeof b.name !== 'string') throw new AitError(2, MSG.nameEmpty, 400);
          return serial(async () => { await prepare(); return [200, await renameSession({ cfg, tmux, name, newName: b.name })]; });
        }
        if (m === 'DELETE') {
          if (url.searchParams.get('confirm') !== 'true') {
            throw new AitError(7, `Kill ${name}? This stops Claude immediately; files it was editing may be partly changed.`, 428);
          }
          const purgeLog = url.searchParams.get('purgeLog') === 'true';
          return serial(async () => { await prepare(); return [200, await killSession({ cfg, tmux, name, purgeLog })]; });
        }
      }
      if (parts.length === 3 && sub === 'open' && m === 'POST') {
        return serial(async () => { await prepare(); return [200, await openSession({ cfg, tmux, name })]; });
      }
      if (parts.length === 3 && sub === 'entry' && m === 'DELETE') {
        const purgeLog = url.searchParams.get('purgeLog') === 'true';
        return serial(async () => { await prepare(); return [200, await removeSession({ cfg, tmux, name, purgeLog })]; });
      }
    }

    if (root === 'dashboard' && parts.length === 1 && m === 'POST') {
      return serial(async () => { await prepare(); return [200, await ensureDashboard({ cfg, tmux, selfPath })]; });
    }

    if (root === 'hooks' && parts.length === 2 && m === 'POST') {
      const event = rawName;
      if (!EVENTS.includes(event)) throw new AitError(2, 'Unknown hook event.', 400);
      const raw = await readBody(req);
      if (raw && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        throw new AitError(2, 'Content-Type must be application/json.', 415);
      }
      const session = req.headers.ait_session ?? req.headers['ait-session'];
      let r;
      try { r = ingest({ home: cfg.home, session: Array.isArray(session) ? session[0] : session, event, stdin: raw }); } catch { r = { accepted: false }; }
      return [200, { accepted: !!r.accepted }];
    }

    if (root === 'doctor' && parts.length === 1 && m === 'GET') return [200, await doctor({ cfg, tmux, env })];
    if (root === 'export' && parts.length === 1 && m === 'GET') return [200, await exportState({ cfg })];
    if (root === 'purge' && parts.length === 1 && m === 'POST') {
      const b = await jsonBody(req);
      onlyKeys(b, ['confirm']);
      return serial(async () => [200, await purgeState({ cfg, tmux, confirm: b.confirm })]);
    }
    throw new AitError(8, 'Not found.', 404);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { status: 'ok' }); return; }
      try { guard(req); } catch (e) {
        audit(cfg.home, { action: 'denied', session: '-', id: 0, result: 'denied' });
        throw e;
      }
      const [status, body] = await route(req, url);
      send(res, status, body);
    } catch (e) {
      if (e instanceof AitError) send(res, statusFor(e), { error: e.code, message: e.message });
      else send(res, 500, { error: 7, message: 'Something went wrong.' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.maxConnections = 100;
  server.listen(cfg.port, cfg.host, () => log(`ait API listening on port ${cfg.port}`));
  return server;
}
