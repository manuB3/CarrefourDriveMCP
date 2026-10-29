import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadToolSpecs } from '../spec/loader.js';
import {
  TOOL_CATALOG,
  annotationsFor,
  isExposed,
  metaFor,
  selectToolsets,
} from '../spec/catalog.js';
import { registerSpecTools, RAW_RESPONSE_PARAM } from '../spec/register.js';

const CHECKOUT = ['validate_checkout_slot', 'validate_checkout_summary', 'submit_checkout_payment'];

function exposedNames(env: NodeJS.ProcessEnv): string[] {
  const server = new McpServer({ name: 't', version: '0' });
  return registerSpecTools(server, loadToolSpecs(), selectToolsets(env)).registered;
}

test('every tool definition is classified in the catalog', () => {
  const { specs } = loadToolSpecs();
  const missing = specs.map((s) => s.name).filter((n) => !TOOL_CATALOG[n]);
  assert.deepEqual(missing, [], `add these to src/spec/catalog.ts: ${missing.join(', ')}`);
  const stale = Object.keys(TOOL_CATALOG).filter((n) => !specs.some((s) => s.name === n));
  assert.deepEqual(stale, [], `catalog entries without a definition: ${stale.join(', ')}`);
});

test('no definition declares a parameter that collides with raw_response', () => {
  for (const spec of loadToolSpecs().specs) {
    assert.ok(!(RAW_RESPONSE_PARAM in (spec.parameters?.properties ?? {})), spec.name);
  }
});

test('every non-GET definition is classified as a write or checkout, unless known read-only', () => {
  const postReads = new Set([
    'get_products_by_gtins',
    'get_marketing_placements',
    'get_chat_preprompts',
    'get_store_information_inserts',
  ]);
  for (const spec of loadToolSpecs().specs) {
    if (spec.request.method === 'GET' || postReads.has(spec.name)) continue;
    assert.notEqual(TOOL_CATALOG[spec.name].kind, 'read', `${spec.name} is a ${spec.request.method}`);
  }
});

test('checkout tools are hidden by default', () => {
  const names = exposedNames({});
  for (const n of CHECKOUT) assert.ok(!names.includes(n), `${n} should be hidden`);
});

test('"all" does not expose checkout without CARREFOUR_ENABLE_CHECKOUT', () => {
  const names = exposedNames({ CARREFOUR_TOOLSETS: 'all' });
  for (const n of CHECKOUT) assert.ok(!names.includes(n));
  assert.ok(names.includes('get_marketing_placements'), 'all should include marketing');
});

test('CARREFOUR_ENABLE_CHECKOUT=1 exposes the checkout tools', () => {
  const names = exposedNames({ CARREFOUR_ENABLE_CHECKOUT: '1' });
  for (const n of CHECKOUT) assert.ok(names.includes(n));
});

test('marketing tools are hidden by default', () => {
  const names = exposedNames({});
  assert.ok(!names.includes('get_olympic_games_prime'));
  assert.ok(names.includes('get_orders'));
});

test('CARREFOUR_TOOLSETS restricts to the listed toolsets', () => {
  const names = exposedNames({ CARREFOUR_TOOLSETS: 'history, cart' });
  assert.ok(names.includes('get_orders'));
  assert.ok(names.includes('get_cart'));
  assert.ok(!names.includes('search_products'));
  assert.ok(!names.includes('get_loyalty_balance'));
});

test('unknown toolset names are reported, not fatal', () => {
  const sel = selectToolsets({ CARREFOUR_TOOLSETS: 'history,bogus' });
  assert.deepEqual(sel.unknown, ['bogus']);
  assert.ok(sel.enabled.has('history'));
});

test('annotations reflect the classification', () => {
  const read = annotationsFor(TOOL_CATALOG.get_orders);
  assert.equal(read.readOnlyHint, true);
  assert.equal(read.destructiveHint, false);

  const write = annotationsFor(TOOL_CATALOG.add_item_to_cart);
  assert.equal(write.readOnlyHint, false);
  assert.equal(write.destructiveHint, false);

  const pay = annotationsFor(TOOL_CATALOG.submit_checkout_payment);
  assert.equal(pay.readOnlyHint, false);
  assert.equal(pay.destructiveHint, true);
  assert.equal(pay.idempotentHint, false);
});

test('unclassified definitions fall back safely', () => {
  assert.equal(metaFor('brand_new_get', 'GET').kind, 'read');
  assert.equal(metaFor('brand_new_post', 'POST').kind, 'write');
  assert.ok(isExposed(metaFor('brand_new_post', 'POST'), selectToolsets({})));
});
