import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { ensureStateDir } from '../src/paths.js';
import { AitError, MSG } from '../src/errors.js';

// Temp state folder, a fake `claude` on PATH and a project folder.
export function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const env = { AIT_HOME: path.join(root, 'home'), PATH: bin, XDG_STATE_HOME: root };
  const cfg = getConfig(env);
  ensureStateDir(cfg.home);
  return { root, home: cfg.home, bin, proj, env, cfg };
}

// In-memory stand-in for the tmux wrapper.
export function fakeTmux() {
  const sessions = new Map();
  const calls = [];
  return {
    sessions,
    calls,
    async version() { return { major: 3, minor: 4 }; },
    async listSessions() {
      return [...sessions].map(([name, s]) => ({ name, attached: s.attached || 0, dead: !!s.dead, deadStatus: s.deadStatus ?? null }));
    },
    async newSession(o) { calls.push(['new', o.name, o]); sessions.set(o.name, { attached: 0, dead: false }); },
    async capture() { return ''; },
    async killSession(n) { calls.push(['kill', n]); sessions.delete(n); },
    async renameSession(a, b) {
      calls.push(['rename', a, b]);
      const s = sessions.get(a);
      if (s) { sessions.delete(a); sessions.set(b, s); }
    },
    async setStatus() {},
    async prefix() { return 'C-b'; },
    async bindReturnKey() { return { bound: true }; },
    async killServer() { calls.push(['killServer']); sessions.clear(); },
    async switchClient() {},
    async switchOrAttach(n) {
      if (!sessions.has(n)) throw new AitError(8, MSG.gone(n));
      calls.push(['open', n]);
    },
    async run() { return ''; },
  };
}
