#!/usr/bin/env node

import { runCli } from '../src/cli/index.js';

runCli(process.argv.slice(2)).catch((error) => {
  const message = error?.stack || error?.message || String(error);
  console.error(message);
  process.exitCode = 1;
});
