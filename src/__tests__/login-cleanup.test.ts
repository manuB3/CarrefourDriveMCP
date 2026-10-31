import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stopBrowser, removeProfile } from '../services/browser-login.js';

test('stopBrowser waits for a process that ignores SIGTERM, then kills it', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
    stdio: 'ignore',
    detached: true,
  });
  await new Promise((r) => setTimeout(r, 200));
  const started = Date.now();
  await stopBrowser(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'process should be gone');
  assert.ok(Date.now() - started < 9000);
});

test('stopBrowser returns at once for a process that already exited', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', detached: true });
  await new Promise((r) => child.once('exit', r));
  await stopBrowser(child);
});

test('removeProfile deletes the directory and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdm-profile-'));
  writeFileSync(join(dir, 'Cookies'), 'x');
  removeProfile(dir);
  assert.equal(existsSync(dir), false);
  removeProfile(join(dir, 'does-not-exist'));
});
