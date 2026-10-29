import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLineItems, findOrder, asEan } from '../services/line-items.js';

test('asEan accepts EAN-8/12/13/14 only', () => {
  assert.equal(asEan('3176571983008'), '3176571983008');
  assert.equal(asEan(3176571983008), '3176571983008');
  assert.equal(asEan('12345678'), '12345678');
  assert.equal(asEan('1234567'), undefined);
  assert.equal(asEan('ABC'), undefined);
  assert.equal(asEan(''), undefined);
});

test('flat lines with quantity and label', () => {
  const items = extractLineItems({
    lines: [
      { ean: '3176571983008', quantity: 2, label: 'Lait' },
      { ean: '3560071267964', qty: '1', title: 'Pain' },
    ],
  });
  assert.deepEqual(items, [
    { ean: '3176571983008', quantity: 2, label: 'Lait' },
    { ean: '3560071267964', quantity: 1, label: 'Pain' },
  ]);
});

test('quantity on the wrapper, EAN on the nested product', () => {
  const items = extractLineItems({
    items: [{ quantity: 3, product: { ean: '3176571983008', title: 'Lait' } }],
  });
  assert.deepEqual(items, [{ ean: '3176571983008', quantity: 3, label: 'Lait' }]);
});

test('weighted quantities become at least one unit', () => {
  const items = extractLineItems([{ ean: '2000000000008', quantity: 0.452 }]);
  assert.equal(items[0].quantity, 1);
});

test('the same EAN on two lines is summed', () => {
  const items = extractLineItems([
    { ean: '3176571983008', quantity: 1 },
    { ean: '3176571983008', quantity: 2 },
  ]);
  assert.deepEqual(items, [{ ean: '3176571983008', quantity: 3 }]);
});

test('product details under a line are not counted again', () => {
  const items = extractLineItems([
    { ean: '3176571983008', quantity: 1, variants: [{ ean: '3176571983015' }] },
  ]);
  assert.equal(items.length, 1);
});

test('an order-level quantity does not leak into deep lines', () => {
  const items = extractLineItems({
    quantity: 12,
    groups: { fresh: { lines: [{ ean: '3176571983008' }] } },
  });
  assert.equal(items[0].quantity, 1);
});

test('missing quantity defaults to 1', () => {
  assert.deepEqual(extractLineItems([{ gtin: '3176571983008' }]), [{ ean: '3176571983008', quantity: 1 }]);
});

test('findOrder locates an order by number anywhere in the payload', () => {
  const payload = {
    content: {
      orders: [
        { orderNumber: 'A1', lines: [] },
        { orderNumber: 'B2', lines: [{ ean: '3176571983008', quantity: 1 }] },
      ],
    },
  };
  const order = findOrder(payload, 'B2');
  assert.ok(order);
  assert.equal(extractLineItems(order).length, 1);
  assert.equal(findOrder(payload, 'Z9'), undefined);
});
