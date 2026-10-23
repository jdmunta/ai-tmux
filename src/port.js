import net from 'node:net';

export const MAX_TRIES = 50;

// Tries to bind (then immediately release) a local port.
// Resolves with the bound port number, or null when it cannot be used.
export function probePort(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(null));
    srv.listen({ port, host, exclusive: true }, () => {
      const bound = srv.address().port;
      srv.close(() => resolve(bound));
    });
  });
}

// Returns the first usable port starting at `start`.
// Order: start, start+1 ... start+maxTries, then an OS-assigned port (0).
// With strict=true only `start` is tried and a busy port throws.
export async function findFreePort(start, host = '0.0.0.0', { maxTries = MAX_TRIES, strict = false, probe = probePort } = {}) {
  const first = await probe(start, host);
  if (first !== null) return first;
  if (strict) {
    const e = new Error(`Port ${start} is already in use.`);
    e.code = 'EADDRINUSE';
    throw e;
  }
  for (let i = 1; i <= maxTries; i++) {
    const p = start + i;
    if (p > 65535) break;
    const got = await probe(p, host);
    if (got !== null) return got;
  }
  const any = await probe(0, host);
  if (any !== null) return any;
  throw new Error('No free port could be found.');
}
