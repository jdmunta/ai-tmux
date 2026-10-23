#!/usr/bin/env node
import { serve } from '../src/serve.js';

try {
  const server = await serve();
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (e) {
  process.stderr.write(`${e && e.code === 'EADDRINUSE' ? e.message : 'Could not start the API.'}\n`);
  process.exit(1);
}
