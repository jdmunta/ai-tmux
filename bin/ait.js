#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { AitError, MSG } from '../src/errors.js';
import { createTmux, versionOk } from '../src/tmux.js';
import { assertSocketSafe } from '../src/security.js';
import { ensureStateDir } from '../src/paths.js';
import { sanitize } from '../src/sanitize.js';
import { launchSession } from '../src/launch.js';
import {
  listSessions, killSession, removeSession, renameSession, openSession,
  ensureDashboard, doctor, exportState, purgeState,
} from '../src/service.js';
import { runHookFromStdin } from '../src/hook.js';
import { run as runDashboard } from '../src/dashboard.js';
import { serve } from '../src/serve.js';
import { audit } from '../src/audit.js';

const cfg = getConfig();
const SELF = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const dd = argv.indexOf('--');
  const main = dd >= 0 ? argv.slice(0, dd) : argv;
  const rest = dd >= 0 ? argv.slice(dd + 1) : [];
  const flags = { json: false, verbose: false, yes: false, purgeLog: false, out: null, confirm: null };
  const pos = [];
  for (let i = 0; i < main.length; i++) {
    const a = main[i];
    if (a === '--json') flags.json = true;
    else if (a === '--verbose') flags.verbose = true;
    else if (a === '--yes') flags.yes = true;
    else if (a === '--purge-log') flags.purgeLog = true;
    else if (a === '--out') flags.out = main[++i] ?? null;
    else if (a === '--confirm') flags.confirm = main[++i] ?? null;
    else pos.push(a);
  }
  return { flags, pos, rest };
}

function fail(e, json) {
  if (e instanceof AitError) {
    if (json) process.stdout.write(JSON.stringify({ error: e.code, message: e.message }) + '\n');
    else process.stderr.write(sanitize(e.message) + '\n');
    process.exit(e.code);
  }
  if (e && e.code === 'EADDRINUSE') {
    process.stderr.write(sanitize(e.message) + '\n');
    process.exit(7);
  }
  process.stderr.write('Something went wrong.\n');
  if (cfg.debug && e && e.stack) process.stderr.write(String(e.stack) + '\n');
  process.exit(1);
}

async function prepareTmux() {
  const tmux = createTmux(cfg);
  const v = await tmux.version();
  if (!versionOk(v)) throw new AitError(10, MSG.tmuxMissing);
  assertSocketSafe(process.env);
  ensureStateDir(cfg.home);
  return tmux;
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try { return (await rl.question(question)).trim().toLowerCase(); } finally { rl.close(); }
}

async function cmdLs(flags) {
  const tmux = await prepareTmux();
  const list = await listSessions({ cfg, tmux, env: process.env }, { verbose: flags.verbose });
  if (flags.json) { process.stdout.write(JSON.stringify(list, null, 2) + '\n'); return; }
  if (!list.sessions.length) { process.stdout.write('No sessions yet. Run: ait new <name> [dir]\n'); return; }
  for (const s of list.sessions) {
    process.stdout.write(`${String(s.id).padStart(3)}  ${s.state.toUpperCase().padEnd(8)} ${sanitize(s.name).padEnd(24)} ${sanitize(s.dir)}${s.degraded ? '  (fallback)' : ''}\n`);
  }
}

async function cmdNew(flags, pos, rest) {
  const tmux = await prepareTmux();
  const [name, dir] = pos;
  const go = (confirm) => launchSession({ cfg, tmux, name, dir, args: rest, confirmProjectHooks: confirm, env: process.env });
  let result;
  try {
    result = await go(flags.yes);
  } catch (e) {
    if (e instanceof AitError && e.needsConfirm && process.stdin.isTTY && !flags.json) {
      if ((await ask(`${e.message} Continue? [y/N] `)) !== 'y') throw e;
      result = await go(true);
    } else throw e;
  }
  if (flags.json) {
    const e = result.entry;
    process.stdout.write(JSON.stringify({ id: e.id, name: e.name, dir: e.dir, branch: e.branch, state: 'running', kind: null, since: e.createdAt, source: 'hook', degraded: false, attached: false, createdAt: e.createdAt, exit: null }) + '\n');
  } else {
    process.stdout.write(`Started ${result.entry.name}. (claude: ${result.claude})\n`);
  }
}

async function cmdKill(flags, pos) {
  const name = pos[0];
  if (!name) throw new AitError(2, MSG.nameEmpty);
  const tmux = await prepareTmux();
  const q = `Kill ${sanitize(name)}? This stops Claude immediately; files it was editing may be partly changed.`;
  if (!flags.yes) {
    if (!process.stdin.isTTY) throw new AitError(7, q + ' Re-run with --yes.');
    if ((await ask(q + ' [y/N] ')) !== 'y') { process.stdout.write('Kept.\n'); return; }
  }
  await killSession({ cfg, tmux, name, purgeLog: flags.purgeLog });
  process.stdout.write(`Killed ${name}.\n`);
}

async function cmdDoctor(flags) {
  const tmux = createTmux(cfg);
  const report = await doctor({ cfg, tmux, env: process.env });
  if (flags.json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return; }
  const l = (k, v) => process.stdout.write(`${k.padEnd(18)} ${v}\n`);
  l('tmux', `${report.tmux.version} ${report.tmux.ok ? 'ok' : '(need 3.2 or newer)'}`);
  l('claude', report.claude.path || 'not found on PATH');
  l('--settings flag', report.hooks.settingsFlagSupported ? 'supported' : 'not detected (fallback detection will be used)');
  l('tmux prefix', report.prefix);
  l('return key', `${report.prefix} ${report.returnKey}`);
  l('tmux socket', `${report.socket.name} ${report.socket.ownerOk ? 'ok' : 'NOT PRIVATE'}`);
  l('notifier', report.notifier);
  l('state folder', `${report.stateDir} ${report.stateDirModesOk ? 'ok' : 'permissions need repair'}`);
  const r = report.remainingState;
  l('stored', `${r.sessions} sessions, ${r.eventFiles} event files, ${r.settingsFiles} settings files`);
  l('network', 'none: nothing is transmitted');
}

async function cmdExport(flags) {
  const doc = await exportState({ cfg });
  const text = JSON.stringify(doc, null, 2) + '\n';
  if (flags.out) {
    try {
      fs.writeFileSync(flags.out, text, { mode: 0o600, flag: 'wx' });
    } catch {
      throw new AitError(7, 'Could not write that file. It may already exist.');
    }
    fs.chmodSync(flags.out, 0o600);
    process.stdout.write('Exported.\n');
  } else process.stdout.write(text);
}

async function cmdPurge(flags) {
  let word = flags.confirm;
  if (word === null) {
    if (!process.stdin.isTTY) throw new AitError(7, 'Type purge to confirm. Use --confirm purge.');
    word = await ask('This erases all ait state and stops the ait tmux server. Type purge to confirm: ');
  }
  const result = await purgeState({ cfg, tmux: createTmux(cfg), confirm: word });
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function cmdDashboard() {
  const tmux = await prepareTmux();
  if (process.env.AIT_DASH_INNER === '1') {
    await runDashboard({ cfg, tmux });
    return;
  }
  await ensureDashboard({ cfg, tmux, selfPath: SELF });
  audit(cfg.home, { action: 'open', session: 'dash', id: 0, result: 'ok' });
  await tmux.switchOrAttach('dash');
}

async function main() {
  const [cmd = '', ...argv] = process.argv.slice(2);
  const { flags, pos, rest } = parseArgs(argv);
  try {
    switch (cmd) {
      case '': await cmdDashboard(); break;
      case 'ls': await cmdLs(flags); break;
      case 'new': await cmdNew(flags, pos, rest); break;
      case 'open': {
        const tmux = await prepareTmux();
        await openSession({ cfg, tmux, name: pos[0] });
        break;
      }
      case 'kill': await cmdKill(flags, pos); break;
      case 'rm': {
        const tmux = await prepareTmux();
        await removeSession({ cfg, tmux, name: pos[0], purgeLog: flags.purgeLog });
        process.stdout.write(`Removed ${pos[0]}.\n`);
        break;
      }
      case 'rename': {
        const tmux = await prepareTmux();
        await renameSession({ cfg, tmux, name: pos[0], newName: pos[1] });
        process.stdout.write(`Renamed ${pos[0]} to ${pos[1]}.\n`);
        break;
      }
      case 'doctor': await cmdDoctor(flags); break;
      case 'export': await cmdExport(flags); break;
      case 'purge': await cmdPurge(flags); break;
      case 'serve': await serve(); return;
      case 'hook': await runHookFromStdin(pos[0]); process.exit(0); break;
      case 'help': case '--help': case '-h':
        process.stdout.write('ait [new <name> [dir] [-- claude args]] | ls | open | kill | rm | rename | doctor | export | purge | serve\n');
        break;
      default:
        throw new AitError(2, 'Unknown command. Run: ait help');
    }
  } catch (e) {
    fail(e, flags.json);
  }
}

await main();
