/**
 * Shrink Carrefour API payloads before they reach the model.
 *
 * The storefront APIs return what the website needs to draw a page: several
 * image sizes per product, tracking blocks, SEO fields, empty arrays and nulls.
 * None of it helps an assistant answer "what did I buy last month", and all of
 * it costs context. This pass is deliberately conservative: it only removes
 * keys that are decorative by name, image URLs, and empty values. Business
 * fields (prices, quantities, EANs, statuses, dates, action links) are kept.
 *
 * Any tool can still be called with `raw_response: true` to get the payload
 * untouched, and CARREFOUR_COMPACT=0 disables the pass globally.
 */

/** Keys removed wherever they appear. Matched on the whole key, case-insensitive. */
const NOISE_KEY =
  /^(images?|imageUrls?|media|medias|pictures?|thumbnails?|visuals?|logos?|icons?|tracking|trackingRequest|trackingData|trackings|analytics|dataLayer|gtm|seo|metaTags?|metas|breadcrumbs?|banners?|_links|htmlDescription|richContent|cssClass(es)?|backgroundColor)$/i;

const IMAGE_URL = /^https?:\/\/\S+\.(jpe?g|png|gif|webp|svg|avif)(\?\S*)?$/i;

const MAX_STRING = 400;

export interface CompactStats {
  before: number;
  after: number;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function prune(value: unknown, depth: number): unknown {
  if (depth > 40) return value;

  if (typeof value === 'string') {
    if (IMAGE_URL.test(value)) return undefined;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }

  if (Array.isArray(value)) {
    const out = value.map((v) => prune(v, depth + 1)).filter((v) => !isEmpty(v));
    return out;
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (NOISE_KEY.test(key)) continue;
      const pruned = prune(v, depth + 1);
      if (!isEmpty(pruned)) out[key] = pruned;
    }
    return out;
  }

  return value;
}

/** Return a compacted copy of `data`. Strings (HTML pages, plain text) are returned as-is. */
export function compact(data: unknown): unknown {
  if (typeof data === 'string') return data;
  const pruned = prune(data, 0);
  return pruned === undefined ? null : pruned;
}

export function compactEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CARREFOUR_COMPACT ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}
