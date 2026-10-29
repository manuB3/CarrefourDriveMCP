import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolSpec } from '../spec/types.js';
import { buildRequest } from '../spec/resolve.js';
import { executeSpecData, type ToolResult } from '../spec/register.js';
import { extractLineItems, findOrder, asEan, type LineItem } from '../services/line-items.js';
import { httpService } from '../services/http.service.js';
import { logger } from '../utils/logger.js';

/** Items per cart PATCH. The endpoint takes an `items` array; keep requests modest. */
const CHUNK_SIZE = 25;

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: body }], isError };
}

function findFirst(data: unknown, key: RegExp, depth = 0): string | undefined {
  if (depth > 20 || data === null || typeof data !== 'object') return undefined;
  if (Array.isArray(data)) {
    for (const d of data) {
      const r = findFirst(d, key, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (key.test(k) && typeof v === 'string' && v) return v;
  }
  for (const v of Object.values(data as Record<string, unknown>)) {
    const r = findFirst(v, key, depth + 1);
    if (r) return r;
  }
  return undefined;
}

function listItems(items: LineItem[]): string {
  return items.map((i) => `- ${i.quantity} × ${i.label ?? '(no label)'} [EAN ${i.ean}]`).join('\n');
}

interface Specs {
  get(name: string): ToolSpec | undefined;
}

/** Fetch the lines to reorder from the requested source. */
async function collect(
  specs: Specs,
  args: Record<string, unknown>
): Promise<{ items: LineItem[]; origin: string } | { error: ToolResult }> {
  const source = args.source as string;

  if (source === 'items') {
    const raw = (args.items as Array<{ ean: string; quantity?: number }>) ?? [];
    const bad = raw.filter((i) => !asEan(i.ean)).map((i) => i.ean);
    if (bad.length) return { error: text(`Not valid EANs: ${bad.join(', ')}`, true) };
    return {
      items: extractLineItems(raw.map((i) => ({ ean: i.ean, quantity: i.quantity ?? 1 }))),
      origin: `${raw.length} item(s) given by the caller`,
    };
  }

  if (source === 'receipt') {
    const spec = specs.get('get_loyalty_order_receipt_details');
    if (!spec) return { error: text('The receipt details endpoint is not loaded.', true) };
    for (const k of ['gln', 'date_key', 'receipt_number']) {
      if (!args[k]) {
        return {
          error: text(
            `source "receipt" needs gln, date_key and receipt_number (missing: ${k}). ` +
              'Get them from get_loyalty_order_receipts.',
            true
          ),
        };
      }
    }
    const res = await executeSpecData(spec, {
      gln: args.gln,
      date_key: args.date_key,
      receipt_number: args.receipt_number,
    });
    if (!res.ok) return { error: res.result };
    return { items: extractLineItems(res.data), origin: `receipt ${args.receipt_number} of ${args.date_key}` };
  }

  // source === 'order'
  const orderNumber = String(args.order_number ?? '').trim();
  if (!orderNumber) {
    return { error: text('source "order" needs order_number. Get it from get_orders or get_last_orders.', true) };
  }
  const attempts: Array<[string, Record<string, unknown>]> = [
    ['get_last_orders', {}],
    ['get_orders', { scrollSize: 50 }],
  ];
  for (const [name, params] of attempts) {
    const spec = specs.get(name);
    if (!spec) continue;
    const res = await executeSpecData(spec, params);
    if (!res.ok) return { error: res.result };
    const order = findOrder(res.data, orderNumber);
    if (!order) continue;
    const items = extractLineItems(order);
    if (items.length === 0) {
      return {
        error: text(
          `Order ${orderNumber} was found, but its payload lists no product lines (Carrefour may only ` +
            'expose them on the order detail page, which this server has no endpoint for yet). ' +
            'Alternatives: source "receipt" for in-store purchases, or get_frequent_purchases then source "items".',
          true
        ),
      };
    }
    return { items, origin: `order ${orderNumber}` };
  }
  return {
    error: text(
      `Order ${orderNumber} not found in the last 50 orders. Check the number with get_orders ` +
        '(it can filter by startDate/endDate).',
      true
    ),
  };
}

/** Put the items in the cart, in chunks, isolating failures item by item. */
async function addAll(
  addSpec: ToolSpec,
  items: LineItem[],
  basketServiceId: string,
  subBasketType: string
): Promise<{ added: LineItem[]; failed: Array<LineItem & { reason: string }> }> {
  const added: LineItem[] = [];
  const failed: Array<LineItem & { reason: string }> = [];

  const send = async (chunk: LineItem[]) => {
    const first = chunk[0];
    const request = buildRequest(addSpec, {
      ean: first.ean,
      counter: first.quantity,
      basketServiceId,
      subBasketType,
      pageType: 'moncompte',
      pageId: 'moncompte',
    });
    if (typeof request.body === 'string') {
      const body = JSON.parse(request.body) as { items?: unknown[] };
      body.items = chunk.map((i) => ({ basketServiceId, counter: i.quantity, ean: i.ean, subBasketType }));
      request.body = JSON.stringify(body);
    }
    return httpService.send(request, { withAuth: true });
  };

  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    try {
      const res = await send(chunk);
      if (res.ok) {
        added.push(...chunk);
        continue;
      }
      logger.info('Cart chunk rejected, retrying item by item', { status: res.status, size: chunk.length });
    } catch (error) {
      logger.error('Cart chunk failed, retrying item by item', { error: String(error) });
    }
    // One unavailable product can make the whole batch fail: find which one.
    for (const item of chunk) {
      try {
        const res = await send([item]);
        if (res.ok) added.push(item);
        else failed.push({ ...item, reason: `HTTP ${res.status}` });
      } catch (error) {
        failed.push({ ...item, reason: (error as Error).message });
      }
    }
  }
  return { added, failed };
}

export function registerReorderTool(server: McpServer, specsByName: Map<string, ToolSpec>): boolean {
  const addSpec = specsByName.get('add_item_to_cart');
  if (!addSpec) return false;

  server.registerTool(
    'carrefour_reorder',
    {
      description:
        'Put the products of a past purchase back in the Carrefour cart in one call. Sources: an in-store ' +
        'receipt (gln, date_key, receipt_number from get_loyalty_order_receipts), a drive/delivery order ' +
        '(order_number from get_orders), or an explicit list of EANs. Runs as a dry run by default: it lists ' +
        'what it found without touching the cart. With dry_run false it SETS each product quantity in the ' +
        'cart (it does not add to a quantity already there) and reports products that could not be added. ' +
        'Never places or pays an order.',
      inputSchema: {
        source: z.enum(['receipt', 'order', 'items']).describe('Where the products come from.'),
        gln: z.string().optional().describe('receipt: store GLN.'),
        date_key: z.string().optional().describe('receipt: transaction date, YYYYMMDD.'),
        receipt_number: z.string().optional().describe('receipt: receipt number, e.g. "1-211-1907".'),
        order_number: z.string().optional().describe('order: the order number shown by get_orders.'),
        items: z
          .array(z.object({ ean: z.string(), quantity: z.number().int().positive().optional() }))
          .optional()
          .describe('items: products to add, by EAN.'),
        exclude_eans: z.array(z.string()).optional().describe('EANs to leave out (things the user does not want again).'),
        basketServiceId: z
          .string()
          .optional()
          .describe('Store/drive basket service id (e.g. "0678-150-7052"). Read from the current cart when omitted.'),
        subBasketType: z
          .string()
          .optional()
          .describe('Sub-basket type, e.g. "drive_clcv". Read from the current cart when omitted.'),
        dry_run: z.boolean().optional().describe('Default true: only list the products. Set false to fill the cart.'),
      },
      annotations: {
        title: 'Reorder a past purchase',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: Record<string, unknown>) => {
      const collected = await collect(specsByName, args);
      if ('error' in collected) return collected.error;

      const exclude = new Set(((args.exclude_eans as string[]) ?? []).map((e) => e.trim()));
      const items = collected.items.filter((i) => !exclude.has(i.ean));
      if (items.length === 0) {
        return text(`No product line found in ${collected.origin}${exclude.size ? ' after exclusions' : ''}.`, true);
      }

      const dryRun = args.dry_run !== false;
      if (dryRun) {
        return text(
          `Dry run: ${items.length} product(s) found in ${collected.origin}.\n${listItems(items)}\n\n` +
            'Nothing was added. Call again with dry_run: false to set these quantities in the cart.'
        );
      }

      let basketServiceId = args.basketServiceId as string | undefined;
      let subBasketType = args.subBasketType as string | undefined;
      if (!basketServiceId || !subBasketType) {
        const cartSpec = specsByName.get('get_cart');
        const cart = cartSpec ? await executeSpecData(cartSpec, {}) : undefined;
        if (cart && !cart.ok) return cart.result;
        basketServiceId ??= findFirst(cart?.data, /^basketServiceId$/i);
        subBasketType ??= findFirst(cart?.data, /^subBasketType$/i);
      }
      if (!basketServiceId || !subBasketType) {
        return text(
          'Could not tell which store the cart belongs to. Pass basketServiceId and subBasketType ' +
            '(visible in get_cart once a store is chosen, or in add_item_to_cart examples).',
          true
        );
      }

      const { added, failed } = await addAll(specsByName.get('add_item_to_cart')!, items, basketServiceId, subBasketType);
      let out = `${added.length} of ${items.length} product(s) from ${collected.origin} set in the cart (${basketServiceId}, ${subBasketType}).`;
      if (failed.length) {
        out +=
          `\n\nNot added (often out of stock or not sold at this store):\n` +
          failed.map((f) => `- ${f.quantity} × ${f.label ?? '(no label)'} [EAN ${f.ean}]: ${f.reason}`).join('\n');
      }
      out += '\n\nCheck the result with get_cart. The order still has to be validated and paid on carrefour.fr.';
      return text(out, failed.length > 0 && added.length === 0);
    }
  );
  return true;
}
