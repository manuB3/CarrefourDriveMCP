#!/usr/bin/env node
/**
 * End-to-end stdio smoke test: spawns the built MCP server, performs the JSON-RPC
 * handshake, lists the tools and prints a report. No Carrefour credentials needed —
 * this exercises the server, not the remote API.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [join(root, 'dist', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, LOG_LEVEL: 'error' },
});

let stdout = '';
let stderr = '';
const pending = new Map();

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
  let idx;
  while ((idx = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, idx).trim();
    stdout = stdout.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
child.stderr.on('data', (c) => (stderr += c.toString()));

function send(id, method, params) {
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
  });
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  if (stderr) console.error(`--- server stderr ---\n${stderr}`);
  child.kill();
  process.exit(1);
}

try {
  const init = await send(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  if (init.error) fail(`initialize returned an error: ${JSON.stringify(init.error)}`);
  console.log(`handshake OK -> ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const listed = await send(2, 'tools/list', {});
  if (listed.error) fail(`tools/list returned an error: ${JSON.stringify(listed.error)}`);
  const tools = listed.result.tools;
  const session = tools.filter((t) => t.name.startsWith('carrefour_'));
  const api = tools.filter((t) => !t.name.startsWith('carrefour_'));

  console.log(`tools/list OK -> ${tools.length} tools (${api.length} API tools + ${session.length} session tools)`);

  const noSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object');
  if (noSchema.length) fail(`tools without a valid inputSchema: ${noSchema.map((t) => t.name).join(', ')}`);

  // Safety defaults: nothing able to pay unless explicitly enabled, and every
  // API tool tells the client whether it only reads.
  const checkoutOn = ['1', 'true', 'yes', 'on'].includes(String(process.env.CARREFOUR_ENABLE_CHECKOUT ?? '').toLowerCase());
  const pay = tools.find((t) => t.name === 'submit_checkout_payment');
  if (!checkoutOn && pay) fail('submit_checkout_payment is exposed without CARREFOUR_ENABLE_CHECKOUT');
  if (checkoutOn && pay && pay.annotations?.destructiveHint !== true) {
    fail('submit_checkout_payment must be annotated destructiveHint: true');
  }
  const unannotated = api.filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean');
  if (unannotated.length) fail(`API tools without readOnlyHint: ${unannotated.map((t) => t.name).join(', ')}`);
  const readOnly = api.filter((t) => t.annotations.readOnlyHint).length;
  console.log(`annotations OK -> ${readOnly} read-only, ${api.length - readOnly} writing; checkout ${pay ? 'ON' : 'off'}`);

  // Calling an authenticated tool without a session must fail cleanly, not crash.
  // Pick a tool that the current CARREFOUR_TOOLSETS actually exposes.
  const probes = [
    ['get_delivery_timeslots', { facilityServiceId: '0000-000-000' }],
    ['get_orders', {}],
    ['get_loyalty_balance', {}],
    ['get_cart', {}],
  ];
  const probe = probes.find(([name]) => api.some((t) => t.name === name));
  if (!probe) fail('no authenticated probe tool exposed with this toolset selection');
  const called = await send(3, 'tools/call', { name: probe[0], arguments: probe[1] });
  if (called.error) fail(`tools/call crashed: ${JSON.stringify(called.error)}`);
  if (/not found/i.test(String(called.result.content?.[0]?.text))) fail(`${probe[0]} is listed but not callable`);
  console.log(`tools/call OK (${probe[0]}) -> isError=${called.result.isError === true}`);
  console.log(`  first line: ${String(called.result.content[0].text).split('\n')[0]}`);

  console.log('\nAPI tools:');
  for (const t of api) console.log(`  - ${t.name}`);
  console.log('\nSession tools:');
  for (const t of session) console.log(`  - ${t.name}`);

  const skipped = stderr.split('\n').filter((l) => l.includes('skipped'));
  console.log(`\nSkipped tool definitions: ${skipped.length ? skipped.join('; ') : 'none'}`);

  child.kill();
  process.exit(0);
} catch (error) {
  fail(error.message);
}
