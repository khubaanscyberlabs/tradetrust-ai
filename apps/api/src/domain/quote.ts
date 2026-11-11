/**
 * TradeTrust AI — deterministic commercial quote engine.
 *
 * This module is intended to execute on the trusted backend.
 * AI output is untrusted. It must never determine payable amounts.
 *
 * Synthetic catalogue used for local development only.
 */

export type Shipping = 'standard' | 'express';

export type DraftLine = {
  sku: string;
  quantity: number;
};

export type DraftInput = {
  items: DraftLine[];
  shipping: Shipping;
  discountBps?: number;
};

export type QuoteLine = {
  sku: string;
  name: string;
  quantity: number;
  unitCents: number;
  lineCents: number;
};

const INVENTORY = new Map<
  string,
  Readonly<{ name: string; unitCents: number; stock: number }>
>([
  [
    'OUTFIT-01',
    Object.freeze({
      name: 'Embroidered Outfit',
      unitCents: 4200,
      stock: 100,
    }),
  ],
  [
    'SCARF-01',
    Object.freeze({
      name: 'Silk Scarf',
      unitCents: 1800,
      stock: 60,
    }),
  ],
  [
    'BAG-01',
    Object.freeze({
      name: 'Artisan Bag',
      unitCents: 5500,
      stock: 30,
    }),
  ],
]);

const SHIPPING_CENTS: Readonly<Record<Shipping, number>> =
  Object.freeze({
    standard: 2500,
    express: 6500,
  });

// Maximum proposed discount: 10%.
// Merchant approval is still mandatory.
const MAX_DISCOUNT_BPS = 1000;

function plain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return false;
  }

  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function keysOnly(
  input: Record<string, unknown>,
  allowed: string[],
) {
  if (Object.keys(input).some(k => !allowed.includes(k))) {
    throw Error('Unexpected field in quote request');
  }
}

export function proposeQuote(value: unknown) {
  if (!plain(value)) {
    throw Error('Quote must be a JSON object');
  }

  keysOnly(value, ['items', 'shipping', 'discountBps']);

  const { items, shipping } = value;

  const discountBps =
    value.discountBps === undefined ? 0 : value.discountBps;

  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > 10
  ) {
    throw Error('Items must contain 1–10 lines');
  }

  if (shipping !== 'standard' && shipping !== 'express') {
    throw Error('Invalid shipping method');
  }

  if (
    typeof discountBps !== 'number' ||
    !Number.isInteger(discountBps) ||
    discountBps < 0 ||
    discountBps > MAX_DISCOUNT_BPS
  ) {
    throw Error('Discount exceeds merchant policy');
  }

  const seen = new Set<string>();

  const lines: QuoteLine[] = items.map((item: unknown) => {
    if (!plain(item)) {
      throw Error('Invalid item');
    }

    keysOnly(item, ['sku', 'quantity']);

    const { sku, quantity } = item;

    if (typeof sku !== 'string' || !INVENTORY.has(sku)) {
      throw Error('Unknown SKU');
    }

    if (seen.has(sku)) {
      throw Error('Duplicate SKU');
    }

    seen.add(sku);

    const product = INVENTORY.get(sku)!;

    if (
      typeof quantity !== 'number' ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > product.stock
    ) {
      throw Error('Invalid quantity or insufficient stock');
    }

    return Object.freeze({
      sku,
      name: product.name,
      quantity,
      unitCents: product.unitCents,
      lineCents: product.unitCents * quantity,
    });
  });

  const subtotalCents = lines.reduce(
    (total, line) => total + line.lineCents,
    0,
  );

  const discountCents = Math.floor(
    subtotalCents * discountBps / 10000,
  );

  const shippingCents = SHIPPING_CENTS[shipping];

  const totalCents =
    subtotalCents - discountCents + shippingCents;

  if (
    ![subtotalCents, discountCents, totalCents].every(
      Number.isSafeInteger,
    )
  ) {
    throw Error('Unsafe amount');
  }

  return Object.freeze({
    currency: 'USD' as const,
    status: 'PROPOSAL_REQUIRES_MERCHANT_APPROVAL' as const,
    lines: Object.freeze(lines),
    discountBps,
    subtotalCents,
    discountCents,
    shippingCents,
    totalCents,
  });
}

export function usd(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}
