import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer as createNetServer, type Server as NetServer } from 'net';
import type { Server } from 'http';
import { createHttpApp, httpConfigFromEnv, type HttpConfig } from '../http/server.js';

const PASSWORD = 'correct horse battery staple';
const STATIC_TOKEN = 'a'.repeat(40);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let server: Server;
let base: string;
let dir: string;
let config: HttpConfig;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s: NetServer = createNetServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      s.close(() => resolve(addr.port));
    });
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cdm-http-'));
  const port = await freePort();
  config = {
    host: '127.0.0.1',
    port,
    publicUrl: new URL(`http://localhost:${port}`),
    password: PASSWORD,
    staticToken: STATIC_TOKEN,
    stateFile: join(dir, 'oauth.json'),
  };
  const { app } = createHttpApp(config);
  await new Promise<void>((resolve) => {
    server = app.listen(port, '127.0.0.1', () => resolve());
  });
  base = `http://localhost:${port}`;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(redirect = REDIRECT) {
  return fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
}

async function authorizePage(clientId: string, challenge: string, state = 'xyz') {
  const url = new URL(`${base}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'carrefour');
  const res = await fetch(url, { redirect: 'manual' });
  const html = await res.text();
  const requestId = /name="request" value="([^"]+)"/.exec(html)?.[1];
  return { res, html, requestId };
}

async function login(requestId: string, password: string) {
  return fetch(`${base}/oauth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: requestId, password }),
    redirect: 'manual',
  });
}

async function token(params: Record<string, string>) {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

async function mcp(accessToken: string | undefined, method: string, params: unknown = {}, id = 1) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

/** Run the whole browser-side flow and return a fresh token pair. */
async function fullFlow(): Promise<{ clientId: string; access: string; refresh: string }> {
  const reg = await register();
  const client = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const { requestId } = await authorizePage(client.client_id, challenge);
  assert.ok(requestId);
  const ok = await login(requestId!, PASSWORD);
  const code = new URL(ok.headers.get('location')!).searchParams.get('code')!;
  const tok = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  const body = (await tok.json()) as { access_token: string; refresh_token: string };
  return { clientId: client.client_id, access: body.access_token, refresh: body.refresh_token };
}

test('health check is public and says nothing about the session', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('/mcp without a token is refused with a pointer to the OAuth metadata', async () => {
  const res = await mcp(undefined, 'tools/list');
  assert.equal(res.status, 401);
  const header = res.headers.get('www-authenticate') ?? '';
  assert.match(header, /Bearer/);
  assert.match(header, /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('/mcp with a wrong token is refused', async () => {
  const res = await mcp('nope', 'tools/list');
  assert.equal(res.status, 401);
});

test('OAuth metadata is published', async () => {
  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.equal(as.authorization_endpoint, `${base}/authorize`);
  assert.equal(as.token_endpoint, `${base}/token`);
  assert.equal(as.registration_endpoint, `${base}/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);

  const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
  assert.equal(pr.resource, `${base}/mcp`);
});

test('client registration only accepts allowed redirect hosts', async () => {
  const bad = await register('https://evil.example/callback');
  assert.equal(bad.status, 400);
  const good = await register();
  assert.equal(good.status, 201);
  const body = (await good.json()) as { client_id: string; client_secret?: string };
  assert.ok(body.client_id);
  assert.equal(body.client_secret, undefined, 'public clients get no secret');
});

test('full flow: password page, code, token, then MCP calls', async () => {
  const reg = await register();
  const client = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkce();

  const page = await authorizePage(client.client_id, challenge, 'state-123');
  assert.equal(page.res.status, 200);
  assert.match(page.html, /Server password/);
  const csp = page.res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/);
  // Browsers apply form-action to the redirect after submit: Claude's origin must be allowed.
  assert.match(csp, /form-action 'self' https:\/\/claude\.ai(;|$)/);
  assert.ok(page.requestId);

  const wrong = await login(page.requestId!, 'not the password');
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/claude\.ai/);
  assert.match(await wrong.text(), /Wrong password/);

  const ok = await login(page.requestId!, PASSWORD);
  assert.equal(ok.status, 302);
  const location = new URL(ok.headers.get('location')!);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get('state'), 'state-123');
  const code = location.searchParams.get('code')!;
  assert.ok(code);

  // The pending request is single use.
  const replay = await login(page.requestId!, PASSWORD);
  assert.equal(replay.status, 400);

  // PKCE is enforced.
  const badVerifier = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: pkce().verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  assert.equal(badVerifier.status, 400);

  // A failed exchange must not leave the code usable either way; get a new one.
  const page2 = await authorizePage(client.client_id, challenge);
  const ok2 = await login(page2.requestId!, PASSWORD);
  const code2 = new URL(ok2.headers.get('location')!).searchParams.get('code')!;

  const tok = await token({
    grant_type: 'authorization_code',
    code: code2,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  assert.equal(tok.status, 200);
  const tokens = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
  assert.equal(tokens.token_type.toLowerCase(), 'bearer');
  assert.ok(tokens.expires_in > 0);

  // Codes are single use.
  const again = await token({
    grant_type: 'authorization_code',
    code: code2,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  assert.equal(again.status, 400);

  const init = await mcp(tokens.access_token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(init.status, 200);
  const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
  assert.equal(initBody.result.serverInfo.name, 'carrefour-drive');

  const list = await mcp(tokens.access_token, 'tools/list', {}, 2);
  assert.equal(list.status, 200);
  const names = ((await list.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
  assert.ok(names.includes('get_orders'));
  assert.ok(names.includes('carrefour_reorder'));
  assert.ok(!names.includes('submit_checkout_payment'));

  // An authenticated tool without a Carrefour session fails cleanly.
  const call = await mcp(tokens.access_token, 'tools/call', { name: 'get_orders', arguments: {} }, 3);
  const callBody = (await call.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(callBody.result.isError, true);
  assert.match(callBody.result.content[0].text, /No Carrefour session/);
});

test('refresh tokens rotate', async () => {
  const { clientId, refresh } = await fullFlow();
  const first = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
  assert.equal(first.status, 200);
  const next = (await first.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(next.refresh_token, refresh);

  const reuse = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
  assert.equal(reuse.status, 400, 'an old refresh token is dead');

  const list = await mcp(next.access_token, 'tools/list');
  assert.equal(list.status, 200);
});

test('revoked access tokens stop working', async () => {
  const { clientId, access } = await fullFlow();
  assert.equal((await mcp(access, 'tools/list')).status, 200);
  const rev = await fetch(`${base}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: access, client_id: clientId }),
  });
  assert.equal(rev.status, 200);
  assert.equal((await mcp(access, 'tools/list')).status, 401);
});

test('the static token works for non-OAuth clients', async () => {
  const res = await mcp(STATIC_TOKEN, 'tools/list');
  assert.equal(res.status, 200);
});

test('tokens survive a restart, and only their hashes are stored', async () => {
  const { access } = await fullFlow();
  const raw = readFileSync(config.stateFile, 'utf8');
  assert.ok(!raw.includes(access), 'the raw access token must not be on disk');

  // A second app over the same state file accepts the token.
  const { provider } = createHttpApp(config);
  const info = await provider.verifyAccessToken(access);
  assert.ok(info.expiresAt! > Date.now() / 1000);
});

test('GET /mcp is not supported in stateless mode', async () => {
  const res = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${STATIC_TOKEN}` } });
  assert.equal(res.status, 405);
});

test('configuration refuses to run without a password or over plain http', () => {
  assert.throws(() => httpConfigFromEnv({}), /MCP_AUTH_PASSWORD/);
  assert.throws(() => httpConfigFromEnv({ MCP_AUTH_PASSWORD: 'short' }), /12 characters/);
  assert.throws(
    () => httpConfigFromEnv({ MCP_AUTH_PASSWORD: PASSWORD, MCP_PUBLIC_URL: 'http://carrefour.example.com' }),
    /https/
  );
  assert.throws(
    () => httpConfigFromEnv({ MCP_AUTH_PASSWORD: PASSWORD, MCP_AUTH_TOKEN: 'short' }),
    /32 characters/
  );
  const ok = httpConfigFromEnv({
    MCP_AUTH_PASSWORD: PASSWORD,
    MCP_PUBLIC_URL: 'https://carrefour.example.com',
    MCP_OAUTH_REDIRECT_HOSTS: 'claude.ai, claude.com',
  });
  assert.equal(ok.publicUrl.hostname, 'carrefour.example.com');
  assert.deepEqual(ok.redirectHosts, ['claude.ai', 'claude.com']);
});
