#!/usr/bin/env node
// GTM Reader. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/seo-automation-toolkit
import { run } from '../src/cli.mjs';

// Piping into a tool that stops reading early (for example "| head") is not an error.
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') process.exit(0);
});

process.exitCode = await run(process.argv.slice(2));
