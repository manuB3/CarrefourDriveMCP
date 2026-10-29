import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, compactEnabled } from '../spec/compact.js';
import { render } from '../spec/register.js';

const order = {
  orderNumber: 'C123',
  status: 'DELIVERED',
  totalAmount: 84.12,
  date: '2026-10-12',
  images: [{ url: 'https://media.carrefour.fr/a.jpg' }],
  tracking: { event: 'view' },
  promo: null,
  notes: '',
  tags: [],
  links: { cancel: '/api/orders/C123/cancel' },
  items: [
    {
      ean: '3176571983008',
      quantity: 2,
      title: 'Lait',
      thumbnail: 'https://media.carrefour.fr/b.png',
      picture: 'https://media.carrefour.fr/c.webp?w=200',
      extra: {},
    },
  ],
};

test('compact drops decorative and empty fields, keeps business data', () => {
  const c = compact(order) as Record<string, any>;
  assert.equal(c.orderNumber, 'C123');
  assert.equal(c.totalAmount, 84.12);
  assert.deepEqual(c.links, { cancel: '/api/orders/C123/cancel' });
  assert.equal(c.items[0].ean, '3176571983008');
  assert.equal(c.items[0].quantity, 2);
  for (const k of ['images', 'tracking', 'promo', 'notes', 'tags']) assert.ok(!(k in c), k);
  for (const k of ['thumbnail', 'picture', 'extra']) assert.ok(!(k in c.items[0]), k);
});

test('compact drops bare image URLs but keeps other URLs', () => {
  const c = compact({ a: 'https://x.fr/p.jpg', b: 'https://x.fr/page' }) as Record<string, unknown>;
  assert.deepEqual(c, { b: 'https://x.fr/page' });
});

test('compact leaves strings (HTML pages) alone', () => {
  assert.equal(compact('<html>hi</html>'), '<html>hi</html>');
});

test('compact keeps zero and false', () => {
  assert.deepEqual(compact({ a: 0, b: false }), { a: 0, b: false });
});

test('render adds a footer in compact mode and nothing in raw mode', () => {
  const small = render(order, false);
  assert.match(small, /compact view/);
  assert.match(small, /raw_response: true/);
  const raw = render(order, true);
  assert.doesNotMatch(raw, /compact view/);
  assert.match(raw, /thumbnail/);
});

test('CARREFOUR_COMPACT=0 disables compaction', () => {
  assert.equal(compactEnabled({ CARREFOUR_COMPACT: '0' }), false);
  assert.equal(compactEnabled({}), true);
});
