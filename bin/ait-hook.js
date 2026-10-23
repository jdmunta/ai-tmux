#!/usr/bin/env node
import { runHookFromStdin } from '../src/hook.js';

// Invoked by Claude Code hooks. Never blocks Claude and always exits 0.
try {
  await runHookFromStdin(process.argv[2]);
} catch {
  // swallowed on purpose
}
process.exit(0);
