import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildRequest } from './resolve.js';
import { schemaToZodShape } from './params.js';
import type { ToolSpec } from './types.js';
import { loadToolSpecs, type LoadResult } from './loader.js';
import { annotationsFor, isExposed, metaFor, selectToolsets, type ToolsetSelection } from './catalog.js';
import { compact, compactEnabled } from './compact.js';
import { httpService } from '../services/http.service.js';
import { sessionService, NO_SESSION_MESSAGE } from '../services/session.service.js';
import { logger } from '../utils/logger.js';

const MAX_RESPONSE_CHARS = parseInt(process.env.CARREFOUR_MAX_RESPONSE_CHARS || '60000', 10);

/** Per-call switch added to every API tool. Never forwarded to Carrefour. */
export const RAW_RESPONSE_PARAM = 'raw_response';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: body }], isError };
}

function stringify(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function truncate(out: string): string {
  if (out.length <= MAX_RESPONSE_CHARS) return out;
  return `${out.slice(0, MAX_RESPONSE_CHARS)}\n\n[truncated: ${out.length} chars total — refine your query or raise CARREFOUR_MAX_RESPONSE_CHARS]`;
}

/**
 * Render a successful payload. In compact mode, decorative fields are dropped
 * and a one-line footer says how to get the full payload back.
 */
export function render(data: unknown, raw: boolean): string {
  if (raw || !compactEnabled() || typeof data === 'string') return truncate(stringify(data));
  const full = stringify(data);
  const small = stringify(compact(data));
  if (small.length >= full.length) return truncate(full);
  return `${truncate(small)}\n\n[compact view: ${small.length} of ${full.length} chars — images, tracking and empty fields removed; call again with ${RAW_RESPONSE_PARAM}: true for the full payload]`;
}

export interface ExecuteResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  /** Ready-to-return MCP result. */
  result: ToolResult;
}

/**
 * Execute one declarative tool and keep the parsed payload, so composite tools
 * (reorder) can read it without parsing text back.
 */
export async function executeSpecData(
  spec: ToolSpec,
  args: Record<string, unknown>,
  opts: { raw?: boolean } = {}
): Promise<ExecuteResult> {
  // An SSO cookie alone is enough: httpService rebuilds the storefront session
  // before the request goes out.
  if (spec.requires_auth && !sessionService.hasSession() && !sessionService.hasSso()) {
    return { ok: false, result: text(NO_SESSION_MESSAGE, true) };
  }

  const { [RAW_RESPONSE_PARAM]: _ignored, ...forwarded } = args;

  let request;
  try {
    request = buildRequest(spec, forwarded);
  } catch (error) {
    return {
      ok: false,
      result: text(`Could not build the request for "${spec.name}": ${(error as Error).message}`, true),
    };
  }

  try {
    const result = await httpService.send(request, { withAuth: spec.requires_auth !== false });

    if (result.status === 401 || result.status === 403) {
      // httpService already tried to refresh and replay this request, so
      // reaching here means the session is really gone.
      return {
        ok: false,
        status: result.status,
        result: text(
          `Carrefour returned ${result.status} for ${spec.name}. The session is expired and could not be ` +
            `renewed automatically.\n\n${NO_SESSION_MESSAGE}`,
          true
        ),
      };
    }

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        data: result.data,
        result: text(
          `HTTP ${result.status} ${result.statusText} on ${request.method} ${request.url}\n\n${render(result.data, true)}`,
          true
        ),
      };
    }

    return { ok: true, status: result.status, data: result.data, result: text(render(result.data, opts.raw === true)) };
  } catch (error) {
    logger.error('Tool execution failed', { tool: spec.name, error: String(error) });
    return { ok: false, result: text(`Request failed for "${spec.name}": ${(error as Error).message}`, true) };
  }
}

/** Execute one declarative tool. Exported so the smoke test can drive it directly. */
export async function executeSpec(spec: ToolSpec, args: Record<string, unknown>): Promise<ToolResult> {
  const raw = args[RAW_RESPONSE_PARAM] === true;
  return (await executeSpecData(spec, args, { raw })).result;
}

export interface RegisterResult extends LoadResult {
  /** Tools actually exposed after toolset filtering. */
  registered: string[];
  /** Tools loaded but hidden by the toolset selection. */
  hidden: string[];
  selection: ToolsetSelection;
}

/**
 * Register the JSON-declared tools on the MCP server, filtered by toolset.
 * All endpoints are served by this one generic executor.
 */
export function registerSpecTools(
  server: McpServer,
  load: LoadResult = loadToolSpecs(),
  selection: ToolsetSelection = selectToolsets(),
  opts: { quiet?: boolean } = {}
): RegisterResult {
  const registered: string[] = [];
  const hidden: string[] = [];

  for (const spec of load.specs) {
    const meta = metaFor(spec.name, spec.request.method);
    if (!isExposed(meta, selection)) {
      hidden.push(spec.name);
      continue;
    }

    const shape = {
      ...schemaToZodShape(spec.parameters),
      [RAW_RESPONSE_PARAM]: z
        .boolean()
        .optional()
        .describe('Return the untouched Carrefour payload instead of the compact view. Default false.'),
    };

    let description = spec.description;
    if (spec.requires_auth) description += ' (requires an authenticated Carrefour session)';
    if (meta.kind === 'checkout') {
      description +=
        ' WARNING: this step moves a real order towards payment. Only call it when the user has ' +
        'explicitly asked to place the order, and confirm the cart, slot and total with them first.';
    }

    server.registerTool(
      spec.name,
      { description, inputSchema: shape, annotations: annotationsFor(meta) },
      async (args: Record<string, unknown>) => executeSpec(spec, args ?? {})
    );
    registered.push(spec.name);
  }

  if (opts.quiet) return { ...load, registered, hidden, selection };

  for (const failure of load.failures) {
    logger.error('Skipped tool definition', failure);
  }
  if (selection.unknown.length > 0) {
    process.stderr.write(
      `[carrefour-drive] unknown toolset(s) in CARREFOUR_TOOLSETS ignored: ${selection.unknown.join(', ')}\n`
    );
  }

  return { ...load, registered, hidden, selection };
}
