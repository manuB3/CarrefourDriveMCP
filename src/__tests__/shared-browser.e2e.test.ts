/**
 * End-to-end check of shared mode against a real Chromium. Skipped unless
 * CARREFOUR_TEST_CHROMIUM points at a Chromium binary (CI unit jobs have none;
 * the Docker job exercises the image instead).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CHROMIUM = process.env.CARREFOUR_TEST_CHROMIUM;
const skip = !CHROMIUM && 'set CARREFOUR_TEST_CHROMIUM to run';

let server: Server;
let origin = '';
let dir = '';

before(async () => {
  if (!CHROMIUM) return;
  dir = mkdtempSync(join(tmpdir(), 'cdm-shared-'));
  Object.assign(process.env, {
    CARREFOUR_SHARED_BROWSER: '1',
    CARREFOUR_SHARED_BROWSER_HEADLESS: '1',
    CARREFOUR_CHROMIUM_PATH: CHROMIUM,
    CARREFOUR_CHROMIUM_NO_SANDBOX: '1',
    CARREFOUR_BROWSER_PROFILE: join(dir, 'profile'),
    CARREFOUR_SHARED_BROWSER_PORT: '9399',
    CARREFOUR_SHARED_START_URL: 'about:blank',
  });
  server = createServer((req, res) => {
    if (req.url === '/api/ping') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ pong: true }));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>park</title>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  origin = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
});

after(async () => {
  if (!CHROMIUM) return;
  const { browserService } = await import('../services/browser.service.js');
  await browserService.shutdown();
  server?.close();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dir, { recursive: true, force: true });
});

async function tabs(): Promise<Array<{ id: string; url: string; type: string }>> {
  const res = await fetch('http://127.0.0.1:9399/json/list');
  return ((await res.json()) as Array<{ id: string; url: string; type: string }>).filter((t) => t.type === 'page');
}

test('requests run in the shared browser, which survives a disconnect', { skip }, async () => {
  const { browserService } = await import('../services/browser.service.js');
  assert.equal(browserService.isShared(), true);

  const first = await browserService.fetch({ method: 'GET', url: `${origin}/api/ping`, headers: {} });
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.text), { pong: true });
  assert.ok((await tabs()).some((t) => t.url.startsWith(origin)), 'a parked tab is open on the origin');

  // Concurrent requests share the parked tab instead of opening one each.
  await browserService.pause('reset');
  browserService.resume();
  await Promise.all([1, 2, 3].map(() => browserService.fetch({ method: 'GET', url: `${origin}/api/ping`, headers: {} })));
  assert.equal((await tabs()).filter((t) => t.url.startsWith(origin)).length, 1, 'one parked tab per origin');

  // The sign-in pauses the server: requests are refused, the browser keeps running,
  // our parked tab is gone, the user's tabs stay.
  await browserService.pause('sign-in in progress');
  await assert.rejects(
    browserService.fetch({ method: 'GET', url: `${origin}/api/ping`, headers: {} }),
    /sign-in in progress/
  );
  const during = await tabs();
  assert.ok(during.length >= 1, 'the browser is still running');
  assert.ok(!during.some((t) => t.url.startsWith(origin)), 'parked tabs are closed when pausing');

  // A tab opened through the HTTP endpoint (as the sign-in does) needs no attachment.
  const shared = await browserService.sharedBrowser();
  const tab = await shared.openTab(`${origin}/login-tab`);
  assert.ok(tab.id);

  browserService.resume();
  const again = await browserService.fetch({ method: 'GET', url: `${origin}/api/ping`, headers: {} });
  assert.equal(again.status, 200, 'requests work again after the sign-in, in the same browser');
  assert.ok((await tabs()).some((t) => t.id === tab.id), "the user's tab was not taken over");
});
