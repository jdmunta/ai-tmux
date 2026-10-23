import { getConfig } from './config.js';
import { findFreePort } from './port.js';

// Starts the HTTP API. If the wanted port is busy, uses the next free one
// and tells the user. `env` is updated so the server picks up the final PORT.
export async function serve({ env = process.env, find = findFreePort, start = null, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const cfg = getConfig(env);
  const strict = env.AIT_PORT_STRICT === '1';
  const port = await find(cfg.port, cfg.host, { strict });
  if (port !== cfg.port) {
    log(`Port ${cfg.port} is in use. Using port ${port} instead.`);
  }
  env.PORT = String(port);
  const startServer = start || (await import('./server.js')).startServer;
  return startServer({ env });
}
