import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { loginPage } from './pages.js';
import { logger } from '../utils/logger.js';

/**
 * A single-user OAuth 2.1 authorization server for this MCP endpoint.
 *
 * Claude's custom connectors (web, desktop, mobile) speak OAuth with dynamic
 * client registration and PKCE. The SDK's router implements the protocol;
 * this provider supplies the decisions:
 *
 *  - who may register: only clients whose redirect URIs point at an allowed
 *    host (Claude's by default), so a stranger cannot mint a client that
 *    redirects codes to their own site;
 *  - who may authorize: whoever types MCP_AUTH_PASSWORD on the consent page,
 *    with a lockout after repeated failures;
 *  - what is stored: client registrations and SHA-256 hashes of the tokens.
 *    A copy of the state file does not let anyone call the server.
 */

const ACCESS_TOKEN_TTL_S = 24 * 3600;
const REFRESH_TOKEN_TTL_S = 90 * 24 * 3600;
const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com', 'localhost', '127.0.0.1'];

export const SCOPE = 'carrefour';

/**
 * CSP of the consent page. Browsers apply `form-action` to the redirects that
 * follow a form submission too, so the client's redirect origin must be listed
 * next to 'self', or the browser stops on the way back to Claude.
 */
export function consentPageCsp(redirectUri?: string): string {
  let target = '';
  try {
    if (redirectUri) target = ` ${new URL(redirectUri).origin}`;
  } catch {
    target = '';
  }
  return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${target}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function safeEqual(a: string, b: string): boolean {
  const ha = Buffer.from(sha256(a), 'hex');
  const hb = Buffer.from(sha256(b), 'hex');
  return timingSafeEqual(ha, hb);
}

interface StoredToken {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

interface State {
  clients: Record<string, OAuthClientInformationFull>;
  /** sha256(access token) -> token info */
  access: Record<string, StoredToken>;
  /** sha256(refresh token) -> token info */
  refresh: Record<string, StoredToken>;
}

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
}

interface IssuedCode {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

export interface OAuthOptions {
  /** Password typed on the consent page. */
  password: string;
  /** Where clients, token hashes are persisted. */
  stateFile: string;
  /** Hosts allowed in registered redirect URIs. */
  redirectHosts?: string[];
  /** Optional static bearer token for non-OAuth clients (Claude Code, scripts). */
  staticToken?: string;
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  private state: State;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();
  private failures: number[] = [];
  private readonly redirectHosts: Set<string>;

  constructor(private readonly options: OAuthOptions) {
    this.redirectHosts = new Set((options.redirectHosts ?? DEFAULT_REDIRECT_HOSTS).map((h) => h.toLowerCase()));
    this.state = this.load();
    this.prune();
  }

  // ---------------------------------------------------------------- storage

  private load(): State {
    const empty: State = { clients: {}, access: {}, refresh: {} };
    if (!existsSync(this.options.stateFile)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(this.options.stateFile, 'utf8')) as Partial<State>;
      return { ...empty, ...parsed };
    } catch (error) {
      logger.error('Could not read the OAuth state file, starting empty', { error: String(error) });
      return empty;
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.options.stateFile), { recursive: true });
      const tmp = `${this.options.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      renameSync(tmp, this.options.stateFile);
    } catch (error) {
      logger.error('Could not persist the OAuth state', { error: String(error) });
    }
  }

  private prune(): void {
    const t = now();
    let changed = false;
    for (const table of [this.state.access, this.state.refresh]) {
      for (const [k, v] of Object.entries(table)) {
        if (v.expiresAt < t) {
          delete table[k];
          changed = true;
        }
      }
    }
    const ms = Date.now();
    for (const [k, v] of this.pending) if (ms - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < ms) this.codes.delete(k);
    if (changed) this.save();
  }

  // --------------------------------------------------------------- clients

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.state.clients[clientId],
      registerClient: (client) => {
        const uris = (client as OAuthClientInformationFull).redirect_uris ?? [];
        for (const uri of uris) {
          let host: string;
          try {
            host = new URL(uri).hostname.toLowerCase();
          } catch {
            throw new InvalidClientMetadataError(`invalid redirect_uri: ${uri}`);
          }
          if (!this.redirectHosts.has(host)) {
            logger.info('Rejected client registration', { redirect_uri: uri });
            throw new InvalidClientMetadataError(
              `redirect_uri host "${host}" is not allowed on this server (MCP_OAUTH_REDIRECT_HOSTS)`
            );
          }
        }
        const full = client as OAuthClientInformationFull;
        if (!full.client_id) {
          full.client_id = randomUUID();
          full.client_id_issued_at = now();
        }
        this.state.clients[full.client_id] = full;
        this.save();
        logger.info('OAuth client registered', { client_id: full.client_id, name: full.client_name });
        return full;
      },
    };
  }

  // --------------------------------------------------------- authorization

  /** First leg: show the password page. The SDK has already validated client and redirect_uri. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.prune();
    const id = randomBytes(24).toString('base64url');
    this.pending.set(id, { client, params, createdAt: Date.now() });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', consentPageCsp(params.redirectUri));
    res.setHeader('X-Frame-Options', 'DENY');
    res.status(200).type('html').send(loginPage({ requestId: id, clientName: client.client_name }));
  }

  private lockedOut(): boolean {
    const cutoff = Date.now() - LOCKOUT_WINDOW_MS;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length >= MAX_FAILURES;
  }

  /**
   * Second leg: the password form posts here. Returns where to send the
   * browser, or a page to show again.
   */
  completeLogin(
    requestId: string,
    password: string
  ): { redirect: string } | { page: string; status: number; redirectUri?: string } {
    this.prune();
    const pending = this.pending.get(requestId);
    if (!pending) {
      return {
        status: 400,
        page: loginPage({ error: 'This sign-in request has expired. Start again from Claude.' }),
      };
    }
    if (this.lockedOut()) {
      return {
        status: 429,
        redirectUri: pending.params.redirectUri,
        page: loginPage({ requestId, clientName: pending.client.client_name, error: 'Too many attempts. Try again in 15 minutes.' }),
      };
    }
    if (!safeEqual(password, this.options.password)) {
      this.failures.push(Date.now());
      logger.info('OAuth login refused: wrong password', { attempts: this.failures.length });
      return {
        status: 401,
        redirectUri: pending.params.redirectUri,
        page: loginPage({ requestId, clientName: pending.client.client_name, error: 'Wrong password.' }),
      };
    }

    this.pending.delete(requestId);
    this.failures = [];
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { clientId: pending.client.client_id, params: pending.params, expiresAt: Date.now() + CODE_TTL_MS });

    const target = new URL(pending.params.redirectUri);
    target.searchParams.set('code', code);
    if (pending.params.state !== undefined) target.searchParams.set('state', pending.params.state);
    logger.info('OAuth authorization granted', { client_id: pending.client.client_id });
    return { redirect: target.toString() };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = this.codes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id || code.expiresAt < Date.now()) {
      throw new InvalidGrantError('invalid or expired authorization code');
    }
    return code.params.codeChallenge;
  }

  // ---------------------------------------------------------------- tokens

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const access = randomBytes(32).toString('base64url');
    const refresh = randomBytes(32).toString('base64url');
    const t = now();
    this.state.access[sha256(access)] = { clientId, scopes, expiresAt: t + ACCESS_TOKEN_TTL_S, resource };
    this.state.refresh[sha256(refresh)] = { clientId, scopes, expiresAt: t + REFRESH_TOKEN_TTL_S, resource };
    this.save();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const code = this.codes.get(authorizationCode);
    // Single use, whatever happens next.
    this.codes.delete(authorizationCode);
    if (!code || code.clientId !== client.client_id || code.expiresAt < Date.now()) {
      throw new InvalidGrantError('invalid or expired authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== code.params.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    const scopes = code.params.scopes?.length ? code.params.scopes : [SCOPE];
    const res = (resource ?? code.params.resource)?.toString();
    return this.issue(client.client_id, scopes, res);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    this.prune();
    const key = sha256(refreshToken);
    const stored = this.state.refresh[key];
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt < now()) {
      throw new InvalidGrantError('invalid or expired refresh token');
    }
    // Rotation: a refresh token works once.
    delete this.state.refresh[key];
    const granted = scopes?.length ? scopes.filter((s) => stored.scopes.includes(s)) : stored.scopes;
    return this.issue(client.client_id, granted, resource?.toString() ?? stored.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.options.staticToken && safeEqual(token, this.options.staticToken)) {
      return { token, clientId: 'static-token', scopes: [SCOPE], expiresAt: now() + 3600 };
    }
    const stored = this.state.access[sha256(token)];
    if (!stored || stored.expiresAt < now()) throw new InvalidTokenError('invalid or expired access token');
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
      ...(stored.resource ? { resource: new URL(stored.resource) } : {}),
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha256(request.token);
    if (this.state.access[key] || this.state.refresh[key]) {
      delete this.state.access[key];
      delete this.state.refresh[key];
      this.save();
    }
  }
}
