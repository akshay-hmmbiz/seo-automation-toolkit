#!/usr/bin/env node
import { run } from '../src/cli.mjs';

// Piping into a tool that stops reading early (for example "| head") is not an error.
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') process.exit(0);
});

process.exitCode = await run(process.argv.slice(2));
