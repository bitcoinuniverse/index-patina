#!/usr/bin/env node
// PATINA indexer command line. Build first with `npm run build`.

import { main } from '../dist/src/cli.js';

const code = await main(process.argv.slice(2));
if (code !== 0) process.exitCode = code;
