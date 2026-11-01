import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginTabDone, withViewerDefaults, remoteLoginUrl, type LoginWatchState } from '../services/browser-login.js';
import { sharedBrowserArgs, sharedBrowserEnabled } from '../services/shared-browser.js';

const LOGIN = 'https://www.carrefour.fr/mon-compte/login';
const IAM = 'https://moncompte.carrefour.fr/iam/XUI/#login/&goto=x';
const HOME = 'https://www.carrefour.fr/';

test('sign-in is done when the tab went through the IAM and came back', () => {
  const s: LoginWatchState = { seenIam: false };
  assert.equal(loginTabDone('about:blank', s, 0), false);
  assert.equal(loginTabDone(LOGIN, s, 1000), false);
  assert.equal(loginTabDone(IAM, s, 2000), false);
  assert.equal(s.seenIam, true);
  assert.equal(loginTabDone(IAM, s, 60_000), false, 'still typing the code');
  assert.equal(loginTabDone('https://www.carrefour.fr/login/check?code=abc', s, 61_000), true);
});

test('a storefront page never preceded by the IAM is not taken for a sign-in at once', () => {
  const s: LoginWatchState = { seenIam: false };
  // e.g. an intermediate www redirect before the IAM shows up
  assert.equal(loginTabDone(HOME, s, 0), false);
  assert.equal(loginTabDone(IAM, s, 1000), false);
  assert.equal(s.storefrontSince, undefined, 'reaching the IAM resets the timer');
});

test('already signed in: the tab settles on the storefront without the IAM', () => {
  const s: LoginWatchState = { seenIam: false };
  assert.equal(loginTabDone('https://www.carrefour.fr/mon-compte', s, 0), false);
  assert.equal(loginTabDone('https://www.carrefour.fr/mon-compte', s, 5000), false);
  assert.equal(loginTabDone('https://www.carrefour.fr/mon-compte', s, 8000), true);
});

test('garbage URLs are ignored', () => {
  assert.equal(loginTabDone('not a url', { seenIam: true }), false);
});

test('the viewer link gets autoconnect and reconnect unless already set', () => {
  const out = new URL(withViewerDefaults('https://login.example.com/vnc.html?autoconnect=1&resize=scale'));
  assert.equal(out.searchParams.get('autoconnect'), '1', 'an explicit value is kept');
  assert.equal(out.searchParams.get('reconnect'), 'true');
  assert.equal(out.searchParams.get('reconnect_delay'), '1000');

  const bare = new URL(withViewerDefaults('https://login.example.com/vnc.html'));
  assert.equal(bare.searchParams.get('autoconnect'), 'true');
  assert.equal(bare.searchParams.get('resize'), 'scale');

  const off = new URL(withViewerDefaults('https://login.example.com/vnc.html?reconnect=false'));
  assert.equal(off.searchParams.get('reconnect'), 'false');

  assert.equal(withViewerDefaults('https://login.example.com/'), 'https://login.example.com/', 'other pages untouched');
  assert.match(remoteLoginUrl({ CARREFOUR_REMOTE_LOGIN_URL: 'https://l.example.com/vnc.html' })!, /reconnect=true/);
  assert.equal(remoteLoginUrl({}), undefined);
});

test('the shared browser is a plain Chromium with a persistent profile', () => {
  const args = sharedBrowserArgs({
    executable: '/x/chrome',
    profileDir: '/data/browser-profile',
    port: 9333,
    windowSize: '1280x900',
    noSandbox: true,
  });
  assert.ok(args.includes('--user-data-dir=/data/browser-profile'));
  assert.ok(args.includes('--remote-debugging-port=9333'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--password-store=basic'), 'needed to save passwords without a keyring');
  assert.ok(args.includes('--window-size=1280,900'));
  assert.ok(args.includes('--no-sandbox'));
  // Nothing that marks the browser as automated, and no headless in production.
  for (const a of args) assert.doesNotMatch(a, /enable-automation|headless|AutomationControlled|remote-debugging-pipe/);
});

test('shared mode needs the switch and a display', () => {
  assert.equal(sharedBrowserEnabled({ CARREFOUR_SHARED_BROWSER: '1' }), false);
  assert.equal(sharedBrowserEnabled({ CARREFOUR_SHARED_BROWSER: '1', DISPLAY: ':99' }), true);
  assert.equal(sharedBrowserEnabled({ DISPLAY: ':99' }), false);
});
