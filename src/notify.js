import { execFile } from 'node:child_process';
import { sanitize } from './sanitize.js';

export function buildNotification(transitions, opts = {}) {
  const picked = transitions.filter((t) => t.to === 'waiting' || (opts.notifyIdle && t.to === 'idle'));
  if (!picked.length) return null;
  if (picked.length > 1) {
    const allWaiting = picked.every((t) => t.to === 'waiting');
    return {
      title: `${picked.length} sessions ${allWaiting ? 'are waiting' : 'need attention'}`,
      body: sanitize(picked.map((t) => t.name).join(', ')).slice(0, 120),
    };
  }
  const t = picked[0];
  const waiting = t.to === 'waiting';
  const title = sanitize(`Claude is ${waiting ? 'waiting' : 'idle'}: ${t.name}`).slice(0, 100);
  const body = opts.notifyShowPath && t.dir ? sanitize(t.dir).slice(0, 200) : (waiting ? 'Needs your input.' : 'Turn finished.');
  return { title, body };
}

// Title and body are separate argv entries; the AppleScript reads them from argv.
export function osascriptArgs(title, body) {
  return ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body];
}

export function notifySendArgs(title, body) {
  return ['--', title, body];
}

export function createNotifier({ cfg, platform = process.platform, env = process.env, execFileImpl = execFile, bell = () => {}, now = Date.now, maxPerMinute = 10 }) {
  const stamps = [];
  return {
    fire(transitions) {
      const n = buildNotification(transitions, cfg);
      if (!n) return { bell: false, desktop: false };
      bell();
      const t = now();
      while (stamps.length && t - stamps[0] > 60000) stamps.shift();
      let desktop = false;
      const can = cfg.desktop !== false && !env.SSH_CONNECTION && (platform === 'darwin' || platform === 'linux') && stamps.length < maxPerMinute;
      if (can) {
        stamps.push(t);
        desktop = true;
        const bin = platform === 'darwin' ? 'osascript' : 'notify-send';
        const args = platform === 'darwin' ? osascriptArgs(n.title, n.body) : notifySendArgs(n.title, n.body);
        try { execFileImpl(bin, args, { timeout: 3000 }, () => {}); } catch { desktop = false; }
      }
      return { bell: true, desktop, ...n };
    },
  };
}
