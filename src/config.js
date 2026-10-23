import os from 'node:os';
import path from 'node:path';

export const MIN_TMUX = { major: 3, minor: 2 };

function parsePort(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 3000;
}

export function getConfig(env = process.env) {
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : path.join(os.homedir(), '.local', 'state');
  const home = path.resolve(env.AIT_HOME || path.join(base, 'ait'));
  const rawSocket = env.AIT_SOCKET || 'ait';
  const socket = /^[A-Za-z0-9_-]{1,32}$/.test(rawSocket) ? rawSocket : 'ait';
  const rawKey = env.AIT_RETURN_KEY || 'Tab';
  const returnKey = /^[A-Za-z0-9-]{1,16}$/.test(rawKey) ? rawKey : 'Tab';
  return {
    home,
    socket,
    returnKey,
    notifyIdle: env.AIT_NOTIFY_IDLE === '1',
    notifyShowPath: env.AIT_NOTIFY_PATH === '1',
    desktop: env.AIT_DESKTOP !== '0',
    debug: env.AIT_DEBUG === '1',
    port: parsePort(env.PORT),
    host: '0.0.0.0',
    apiToken: env.AIT_API_TOKEN || '',
  };
}
