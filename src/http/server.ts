import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createServer } from '../server.js';
import { SingleUserOAuthProvider, SCOPE } from './oauth.js';
import { dataPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

export interface HttpConfig {
  host: string;
  port: number;
  /** Public base URL, as Claude reaches it (https://… behind a tunnel). */
  publicUrl: URL;
  password: string;
  staticToken?: string;
  redirectHosts?: string[];
  stateFile: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function list(value: string | undefined): string[] | undefined {
  const items = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** Read and validate the HTTP configuration. Throws with an actionable message. */
export function httpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const port = parseInt(env.MCP_HTTP_PORT || '8787', 10);
  const host = env.MCP_HTTP_HOST || '127.0.0.1';
  const publicUrl = new URL(env.MCP_PUBLIC_URL || `http://localhost:${port}`);
  if (publicUrl.protocol !== 'https:' && !LOOPBACK.has(publicUrl.hostname)) {
    throw new Error(`MCP_PUBLIC_URL must be https (got ${publicUrl.toString()}).`);
  }

  const password = env.MCP_AUTH_PASSWORD ?? '';
  if (password.length < 12) {
    throw new Error(
      'MCP_AUTH_PASSWORD must be set (12 characters or more): it is the password asked when ' +
        'Claude connects. This server can act on your Carrefour account, so it never runs without one.'
    );
  }
  const staticToken = env.MCP_AUTH_TOKEN || undefined;
  if (staticToken && staticToken.length < 32) {
    throw new Error('MCP_AUTH_TOKEN must be 32 characters or more (e.g. `openssl rand -hex 32`).');
  }

  return {
    host,
    port,
    publicUrl,
    password,
    staticToken,
    redirectHosts: list(env.MCP_OAUTH_REDIRECT_HOSTS),
    stateFile: env.MCP_OAUTH_STATE_FILE || dataPath('oauth', 'state.json'),
  };
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

export function createHttpApp(config: HttpConfig): { app: Express; provider: SingleUserOAuthProvider } {
  const provider = new SingleUserOAuthProvider({
    password: config.password,
    stateFile: config.stateFile,
    redirectHosts: config.redirectHosts,
    staticToken: config.staticToken,
  });

  const mcpUrl = new URL('/mcp', config.publicUrl);
  const app = express();
  app.disable('x-powered-by');
  // Behind Cloudflare Tunnel / a reverse proxy: the client IP is in X-Forwarded-For.
  app.set('trust proxy', 1);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      baseUrl: config.publicUrl,
      scopesSupported: [SCOPE],
      resourceName: 'Carrefour Drive MCP',
      resourceServerUrl: mcpUrl,
    })
  );

  app.post('/oauth/login', express.urlencoded({ extended: false, limit: '4kb' }), (req: Request, res: Response) => {
    const requestId = typeof req.body?.request === 'string' ? req.body.request : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const outcome = provider.completeLogin(requestId, password);
    res.setHeader('Cache-Control', 'no-store');
    if ('redirect' in outcome) {
      res.redirect(302, outcome.redirect);
      return;
    }
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.status(outcome.status).type('html').send(outcome.page);
  });

  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // Stateless Streamable HTTP: one MCP server and transport per request. The
  // tools share process-wide services, so nothing is lost between requests.
  app.post('/mcp', auth, express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const { server } = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('MCP request failed', { error: String(error) });
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
    }
  });

  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', auth, (_req: Request, res: Response) => {
      jsonRpcError(res, 405, 'Method not allowed: this server is stateless, use POST.');
    });
  }

  return { app, provider };
}

export function startHttpServer(config: HttpConfig = httpConfigFromEnv()): Promise<Server> {
  const { app } = createHttpApp(config);
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      process.stderr.write(
        `[carrefour-drive] HTTP MCP server listening on http://${config.host}:${config.port} ` +
          `(public: ${new URL('/mcp', config.publicUrl).toString()})\n`
      );
      resolve(server);
    });
    server.on('error', reject);
  });
}
