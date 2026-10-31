import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SingleUserOAuthProvider } from '../http/oauth.js';
import { loginBrowserArgs } from '../services/browser-login.js';

function provider(dir: string) {
  return new SingleUserOAuthProvider({ password: 'correct horse battery staple', stateFile: join(dir, 's.json') });
}

/** Open a pending authorization the way the SDK's /authorize handler would. */
async function pending(p: SingleUserOAuthProvider): Promise<string> {
  let html = '';
  const res = {
    setHeader() {
      return res;
    },
    status() {
      return res;
    },
    type() {
      return res;
    },
    send(body: string) {
      html = body;
      return res;
    },
  };
  const client = { client_id: 'c1', redirect_uris: ['https://claude.ai/cb'] } as never;
  await p.authorize(client, { codeChallenge: 'x', redirectUri: 'https://claude.ai/cb', state: 's' }, res as never);
  return /name="request" value="([^"]+)"/.exec(html)![1];
}

test('ten wrong passwords lock the consent page, even for the right one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdm-lock-'));
  try {
    const p = provider(dir);
    const id = await pending(p);
    for (let i = 0; i < 10; i++) {
      const r = p.completeLogin(id, `wrong-${i}`);
      assert.ok('status' in r && r.status === 401);
    }
    const locked = p.completeLogin(id, 'correct horse battery staple');
    assert.ok('status' in locked && locked.status === 429);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the consent page escapes the client name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdm-xss-'));
  try {
    const p = provider(dir);
    let html = '';
    const res = {
      setHeader: () => res,
      status: () => res,
      type: () => res,
      send: (b: string) => ((html = b), res),
    };
    const client = { client_id: 'c1', client_name: '<script>alert(1)</script>', redirect_uris: ['https://claude.ai/cb'] } as never;
    await p.authorize(client, { codeChallenge: 'x', redirectUri: 'https://claude.ai/cb' }, res as never);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sign-in browser arguments for a container', () => {
  const desktop = loginBrowserArgs('/tmp/p', 9222, {});
  assert.ok(!desktop.includes('--no-sandbox'));
  assert.ok(!desktop.some((a) => a.startsWith('--window-size')));

  const container = loginBrowserArgs('/tmp/p', 9222, {
    CARREFOUR_REMOTE_LOGIN_URL: 'https://login.example.com',
    CARREFOUR_CHROMIUM_NO_SANDBOX: '1',
    CARREFOUR_LOGIN_WINDOW_SIZE: '1024x768',
  });
  assert.ok(container.includes('--no-sandbox'));
  assert.ok(container.includes('--window-size=1024,768'));
  assert.match(container[container.length - 1], /mon-compte\/login$/);
});
