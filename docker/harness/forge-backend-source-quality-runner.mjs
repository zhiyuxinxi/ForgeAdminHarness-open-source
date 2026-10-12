#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOURCE_QUALITY_BUNDLE_SHA256 } from './forge-backend-source-quality.mjs';

const script = fileURLToPath(new URL('./backend-source-quality/run.py', import.meta.url));
const result = spawnSync('/usr/bin/python3', ['-I', script, '--bundle-sha256', SOURCE_QUALITY_BUNDLE_SHA256,
  ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) process.stderr.write(`SOURCE_QUALITY_EXECUTOR_UNAVAILABLE: ${result.error.code}\n`);
process.exitCode = result.status ?? 2;
