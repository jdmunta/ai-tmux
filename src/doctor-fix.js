import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureStateDir } from './paths.js';
import { socketDir } from './security.js';

function hasCmd(name, env) {
  return String(env.PATH || '').split(path.delimiter).some((d) => {
    try { fs.accessSync(path.join(d || '.', name), fs.constants.X_OK); return true; } catch { return false; }
  });
}

// Turns a doctor report into a list of fixes.
// Each fix: { id, problem, command, argv, run }. `argv` or `run` makes it auto-fixable;
// a fix with neither is advice only.
export function suggestFixes(report, { cfg, env = process.env, platform = process.platform, has = (n) => hasCmd(n, env) } = {}) {
  const fixes = [];
  const brew = has('brew');
  const apt = has('apt-get');

  if (!report.tmux.ok) {
    const what = report.tmux.version === 'missing' ? 'tmux is not installed' : `tmux ${report.tmux.version} is too old (need 3.2 or newer)`;
    if (brew) fixes.push({ id: 'tmux', problem: what, command: 'brew install tmux', argv: ['brew', ['install', 'tmux']] });
    else if (apt) fixes.push({ id: 'tmux', problem: what, command: 'sudo apt-get install -y tmux', argv: ['sudo', ['apt-get', 'install', '-y', 'tmux']] });
    else fixes.push({ id: 'tmux', problem: what, command: 'install tmux 3.2+ with your package manager (dnf, pacman, ...)', argv: null });
  }

  if (!report.claude.ok) {
    const problem = 'Claude Code (`claude`) was not found on PATH';
    if (platform === 'darwin' && brew) fixes.push({ id: 'claude', problem, command: 'brew install --cask claude-code', argv: ['brew', ['install', '--cask', 'claude-code']] });
    else if (has('npm')) fixes.push({ id: 'claude', problem, command: 'npm install -g @anthropic-ai/claude-code', argv: ['npm', ['install', '-g', '@anthropic-ai/claude-code']] });
    else fixes.push({ id: 'claude', problem, command: 'install Node.js 22+ (nodejs.org), then: npm install -g @anthropic-ai/claude-code', argv: null });
  } else {
    if (report.claude.worldWritable) {
      fixes.push({ id: 'claude-perms', problem: 'the folder holding `claude` is world-writable', command: `chmod go-w "$(dirname ${report.claude.path})"`, argv: null });
    }
    if (!report.hooks.settingsFlagSupported) {
      fixes.push({ id: 'claude-update', problem: 'this Claude Code does not support --settings (ait falls back to screen guessing)', command: 'claude update', argv: [report.claude.path, ['update']] });
    }
  }

  if (!report.socket.ownerOk) {
    const dir = socketDir(env, process.getuid());
    fixes.push({
      id: 'socket-dir',
      problem: 'the tmux socket folder is not private',
      command: `chmod 700 ${dir}`,
      run: () => fs.chmodSync(dir, 0o700),
    });
  }

  if (!report.stateDirModesOk && cfg) {
    fixes.push({
      id: 'state-dir',
      problem: 'the ait state folder has loose permissions',
      command: `chmod 700 ${report.stateDir} (and 600 on its files)`,
      run: () => ensureStateDir(cfg.home),
    });
  }

  return fixes;
}

// Runs one fix. Resolves { ok, error? }.
export async function applyFix(fix) {
  try {
    if (fix.run) { fix.run(); return { ok: true }; }
    if (fix.argv) {
      return await new Promise((resolve) => {
        const child = spawn(fix.argv[0], fix.argv[1], { stdio: 'inherit' });
        child.on('error', (e) => resolve({ ok: false, error: e.message }));
        child.on('close', (code, sig) => resolve(code === 0 ? { ok: true } : { ok: false, error: `exit ${code ?? sig}` }));
      });
    }
    return { ok: false, error: 'no automatic fix' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
