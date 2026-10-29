#!/usr/bin/env node
/**
 * Run the compiled test files with node:test.
 *
 * Passing an explicit file list keeps this working the same way on every shell
 * and Node version: cmd.exe does not strip single quotes, and Node only
 * expands glob patterns in `--test` arguments from v21.
 */
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', '__tests__');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error(`No compiled tests in ${dir}. Run "npm run build" first.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
