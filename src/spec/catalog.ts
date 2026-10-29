/**
 * Classification of every tool: which toolset it belongs to and what it does
 * to the user's account. This drives three things:
 *
 *  - which tools are exposed (CARREFOUR_TOOLSETS / CARREFOUR_ENABLE_CHECKOUT);
 *  - the MCP annotations clients use to decide when to ask for confirmation;
 *  - the default "compact" rendering of responses.
 *
 * The HTTP method is not enough to tell a read from a write here: several
 * read-only endpoints are POSTs (`get_products_by_gtins`, marketing placements…).
 * A test asserts that every JSON definition has an entry, so a newly captured
 * endpoint cannot ship unclassified.
 */

export type Toolset =
  | 'catalog'
  | 'cart'
  | 'stores'
  | 'history'
  | 'loyalty'
  | 'lists'
  | 'account'
  | 'checkout'
  | 'marketing';

export const ALL_TOOLSETS: readonly Toolset[] = [
  'catalog',
  'cart',
  'stores',
  'history',
  'loyalty',
  'lists',
  'account',
  'checkout',
  'marketing',
];

/**
 * Exposed when CARREFOUR_TOOLSETS is not set. `checkout` can spend money and
 * `marketing` is noise that costs context on every conversation.
 */
export const DEFAULT_TOOLSETS: readonly Toolset[] = [
  'catalog',
  'cart',
  'stores',
  'history',
  'loyalty',
  'lists',
  'account',
];

/**
 * - `read`: no side effect on the account.
 * - `write`: changes the cart, a list or a slot; reversible by the user.
 * - `checkout`: moves an order towards payment. Never exposed unless
 *   CARREFOUR_ENABLE_CHECKOUT=1.
 */
export type ToolKind = 'read' | 'write' | 'checkout';

export interface ToolMeta {
  toolset: Toolset;
  kind: ToolKind;
  /** Calling twice with the same arguments leaves the account in the same state. */
  idempotent?: boolean;
}

export const TOOL_CATALOG: Record<string, ToolMeta> = {
  // catalog
  autocomplete_search: { toolset: 'catalog', kind: 'read' },
  search_products: { toolset: 'catalog', kind: 'read' },
  get_products_by_gtins: { toolset: 'catalog', kind: 'read' },
  get_products_by_query: { toolset: 'catalog', kind: 'read' },
  get_product_reviews: { toolset: 'catalog', kind: 'read' },
  get_navigation_tree: { toolset: 'catalog', kind: 'read' },
  get_product_recommendations: { toolset: 'catalog', kind: 'read' },
  get_personalized_recommendations: { toolset: 'catalog', kind: 'read' },

  // cart
  get_cart: { toolset: 'cart', kind: 'read' },
  simulate_cart_for_store: { toolset: 'cart', kind: 'read' },
  get_checkout_recommendations: { toolset: 'cart', kind: 'read' },
  add_item_to_cart: { toolset: 'cart', kind: 'write', idempotent: true },
  add_item_to_cart_by_ean: { toolset: 'cart', kind: 'write' },
  apply_promo_code_to_cart: { toolset: 'cart', kind: 'write', idempotent: true },

  // stores and slots
  get_eligible_drive_stores: { toolset: 'stores', kind: 'read' },
  get_favorite_store: { toolset: 'stores', kind: 'read' },
  get_delivery_timeslots: { toolset: 'stores', kind: 'read' },
  get_store_information_inserts: { toolset: 'stores', kind: 'read' },
  select_cart_delivery_slot: { toolset: 'stores', kind: 'write', idempotent: true },

  // purchase history
  get_orders: { toolset: 'history', kind: 'read' },
  get_last_orders: { toolset: 'history', kind: 'read' },
  get_frequent_purchases: { toolset: 'history', kind: 'read' },
  get_loyalty_order_receipts: { toolset: 'history', kind: 'read' },
  get_loyalty_order_receipt_details: { toolset: 'history', kind: 'read' },
  get_vignettes_products: { toolset: 'history', kind: 'read' },

  // loyalty
  get_loyalty_balance: { toolset: 'loyalty', kind: 'read' },
  get_loyalty_cards: { toolset: 'loyalty', kind: 'read' },
  get_loyalty_coupon_collection: { toolset: 'loyalty', kind: 'read' },
  get_loyalty_coupons_dashboard: { toolset: 'loyalty', kind: 'read' },
  get_advantage_codes: { toolset: 'loyalty', kind: 'read' },
  get_account_kpis: { toolset: 'loyalty', kind: 'read' },

  // shopping lists
  get_shopping_lists: { toolset: 'lists', kind: 'read' },
  get_shopping_list: { toolset: 'lists', kind: 'read' },
  create_shopping_list: { toolset: 'lists', kind: 'write' },

  // account
  get_user_consents: { toolset: 'account', kind: 'read' },

  // checkout: can lead to a real order and a real payment
  validate_checkout_slot: { toolset: 'checkout', kind: 'checkout' },
  validate_checkout_summary: { toolset: 'checkout', kind: 'checkout' },
  submit_checkout_payment: { toolset: 'checkout', kind: 'checkout' },

  // marketing: site furniture, rarely useful to an assistant
  get_chat_preprompts: { toolset: 'marketing', kind: 'read' },
  get_marketing_placements: { toolset: 'marketing', kind: 'read' },
  get_homepage_returning_banner: { toolset: 'marketing', kind: 'read' },
  get_olympic_games_prime: { toolset: 'marketing', kind: 'read' },
  get_donation_products: { toolset: 'marketing', kind: 'read' },
};

/** Fallback for a definition added to tools/ without a catalog entry. */
export function metaFor(name: string, method: string): ToolMeta {
  const known = TOOL_CATALOG[name];
  if (known) return known;
  // Unknown endpoints: assume a write unless it is a plain GET, and never
  // treat them as checkout (they are filtered like any other toolset member).
  return { toolset: 'catalog', kind: method === 'GET' ? 'read' : 'write' };
}

export interface ToolsetSelection {
  enabled: Set<Toolset>;
  checkoutEnabled: boolean;
  /** Names in CARREFOUR_TOOLSETS that are not a known toolset. */
  unknown: string[];
}

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Read the selection from the environment.
 *
 * CARREFOUR_TOOLSETS: comma-separated toolsets, or "all". Unset = defaults.
 * CARREFOUR_ENABLE_CHECKOUT: must be truthy for the checkout tools to be
 * exposed, even when "checkout" or "all" is listed. Two switches on purpose:
 * "all" should never silently mean "able to pay".
 */
export function selectToolsets(env: NodeJS.ProcessEnv = process.env): ToolsetSelection {
  const raw = (env.CARREFOUR_TOOLSETS ?? '').trim();
  const checkoutEnabled = truthy(env.CARREFOUR_ENABLE_CHECKOUT);
  const unknown: string[] = [];
  let enabled: Set<Toolset>;

  if (!raw) {
    enabled = new Set(DEFAULT_TOOLSETS);
  } else {
    enabled = new Set();
    for (const part of raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      if (part === 'all') {
        ALL_TOOLSETS.forEach((t) => enabled.add(t));
      } else if ((ALL_TOOLSETS as readonly string[]).includes(part)) {
        enabled.add(part as Toolset);
      } else {
        unknown.push(part);
      }
    }
  }

  if (checkoutEnabled) enabled.add('checkout');
  else enabled.delete('checkout');

  return { enabled, checkoutEnabled, unknown };
}

export function isExposed(meta: ToolMeta, selection: ToolsetSelection): boolean {
  if (meta.kind === 'checkout' && !selection.checkoutEnabled) return false;
  return selection.enabled.has(meta.toolset);
}

/** MCP tool annotations (spec 2025-03-26) derived from the classification. */
export function annotationsFor(meta: ToolMeta, title?: string) {
  return {
    ...(title ? { title } : {}),
    readOnlyHint: meta.kind === 'read',
    destructiveHint: meta.kind === 'checkout',
    idempotentHint: meta.kind === 'read' ? true : meta.idempotent === true,
    openWorldHint: true,
  };
}
