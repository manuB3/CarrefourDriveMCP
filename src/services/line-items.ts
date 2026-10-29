/**
 * Extract product lines (EAN + quantity + label) from an arbitrary Carrefour
 * payload: a drive order, an in-store receipt, a shopping list…
 *
 * The captured endpoint definitions do not include response samples, so this
 * does not rely on one exact shape. It walks the JSON and treats any object
 * carrying an EAN-like field as a line, looking for its quantity and label on
 * the same object, its `product` child, or the parent that wraps it
 * (`{ quantity: 2, product: { ean: "…" } }`).
 */

export interface LineItem {
  ean: string;
  quantity: number;
  label?: string;
}

const EAN_KEY = /^(ean|ean13|gtin|gtin13|productEan|eanCode|codeEan|barcode)$/i;
const QTY_KEY = /^(quantity|qty|counter|quantite|quantité|itemQuantity)$/i;
const LABEL_KEY = /^(label|title|name|libelle|libellé|designation|productName|productTitle|productLabel)$/i;

/** EAN-8, UPC-A, EAN-13 and GTIN-14. */
export function asEan(value: unknown): string | undefined {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^(\d{8}|\d{12,14})$/.test(s) ? s : undefined;
}

function asQuantity(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  // Items sold by weight come back as 0.452 (kg): the cart counts units.
  return Math.max(1, Math.round(n));
}

function pick<T>(obj: Record<string, unknown>, key: RegExp, cast: (v: unknown) => T | undefined): T | undefined {
  for (const [k, v] of Object.entries(obj)) {
    if (key.test(k)) {
      const c = cast(v);
      if (c !== undefined) return c;
    }
  }
  return undefined;
}

const asLabel = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Walk `data` and return one entry per EAN, quantities summed across lines. */
export function extractLineItems(data: unknown): LineItem[] {
  const byEan = new Map<string, LineItem>();
  const order: string[] = [];

  const visit = (node: unknown, inheritedQty?: number, inheritedLabel?: string, depth = 0): void => {
    if (depth > 30) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, undefined, undefined, depth + 1));
      return;
    }
    if (!isObject(node)) return;

    const localQty = pick(node, QTY_KEY, asQuantity);
    const localLabel = pick(node, LABEL_KEY, asLabel);
    const product = isObject(node.product) ? node.product : undefined;
    const qty = localQty ?? inheritedQty;
    const label = localLabel ?? (product && pick(product, LABEL_KEY, asLabel)) ?? inheritedLabel;
    const ean = pick(node, EAN_KEY, asEan);

    if (ean) {
      const existing = byEan.get(ean);
      if (existing) {
        existing.quantity += qty ?? 1;
        if (!existing.label && label) existing.label = label;
      } else {
        byEan.set(ean, { ean, quantity: qty ?? 1, ...(label ? { label } : {}) });
        order.push(ean);
      }
      // A line is a leaf for our purpose: its children are product details
      // (variants, related offers) whose EANs must not be counted again.
      return;
    }

    for (const value of Object.values(node)) {
      // Quantity and label only flow one level down, into the wrapped product.
      if (isObject(value)) visit(value, localQty, localLabel, depth + 1);
      else if (Array.isArray(value)) visit(value, undefined, undefined, depth + 1);
    }
  };

  visit(data);
  return order.map((ean) => byEan.get(ean)!);
}

const ORDER_ID_KEY = /^(id|number|ref|reference|orderId|orderNumber|orderRef|orderReference|numeroCommande|commandeId|code)$/i;

/** Find the object describing order `orderNumber` anywhere in a payload. */
export function findOrder(data: unknown, orderNumber: string): Record<string, unknown> | undefined {
  const wanted = orderNumber.trim();
  let found: Record<string, unknown> | undefined;

  const visit = (node: unknown, depth = 0): void => {
    if (found || depth > 30) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1));
      return;
    }
    if (!isObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (ORDER_ID_KEY.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim() === wanted) {
        found = node;
        return;
      }
    }
    Object.values(node).forEach((v) => visit(v, depth + 1));
  };

  visit(data);
  return found;
}
