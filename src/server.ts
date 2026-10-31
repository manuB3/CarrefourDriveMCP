import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSpecTools } from './spec/register.js';
import { loadToolSpecs, type LoadResult } from './spec/loader.js';
import { selectToolsets } from './spec/catalog.js';
import { registerSessionTools } from './tools/session.tools.js';
import { registerReorderTool } from './tools/reorder.tools.js';
import { logger } from './utils/logger.js';

export const SERVER_NAME = 'carrefour-drive';
export const SERVER_VERSION = '2.1.0';

let cachedLoad: LoadResult | null = null;
let reported = false;

/** Tool definitions are read from disk once per process, not once per HTTP request. */
function toolDefinitions(): LoadResult {
  if (!cachedLoad) cachedLoad = loadToolSpecs();
  return cachedLoad;
}

/**
 * Build an MCP server with every tool registered.
 *
 * The stdio entry point builds one for the life of the process; the HTTP
 * entry point builds one per request (stateless mode). Either way the
 * services behind the tools (cookie jar, browser, rate limiter) are
 * process-wide singletons, so every server instance shares one session.
 */
export function createServer(): { server: McpServer; toolCount: number } {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerSessionTools(server);
  const load = toolDefinitions();
  const reg = registerSpecTools(server, load, selectToolsets(), { quiet: reported });

  // Composite tool: reads history endpoints and writes the cart, so it follows
  // the cart toolset whatever the history toolset says.
  const reorder =
    reg.selection.enabled.has('cart') &&
    registerReorderTool(server, new Map(load.specs.map((s) => [s.name, s])));

  if (!reported) {
    reported = true;
    for (const f of load.failures) {
      process.stderr.write(`[carrefour-drive] skipped ${f.file}: ${f.reason}\n`);
    }
    logger.info('Tools registered', {
      declarative: load.specs.length,
      exposed: reg.registered.length,
      hidden: reg.hidden.length,
      toolsets: [...reg.selection.enabled],
      checkout: reg.selection.checkoutEnabled,
      reorder: Boolean(reorder),
      failed: load.failures.length,
      dir: load.dir,
    });
  }

  return { server, toolCount: reg.registered.length };
}
