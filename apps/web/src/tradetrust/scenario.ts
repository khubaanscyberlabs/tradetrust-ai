/**
 * A deliberately isolated illustration of price and negotiation guardrails.
 * NOT the project's authoritative quote engine, merchant approval, AI, D1,
 * PayPal integration, or financial ledger. For browser UI preview only.
 * No API/network access. The real amount comes from trusted backend records.
 */
export type DemoShipping = 'STANDARD' | 'EXPRESS';
export type DemoRequest = Readonly<{
  quantity: number;
  shipping: DemoShipping;
  discountBps: number;
}>;
export type DemoQuote = Readonly<{
  quantity: number;
  unitCents: number;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  discountBps: number;
  eligible: boolean;
  shipping: DemoShipping;
}>;
const UNIT_CENTS = 9900;
const MAX_DISCOUNT_BPS = 500;
const SHIPPING_CENTS: Readonly<Record<DemoShipping, number>> = Object.freeze({
  STANDARD: 1000,
  EXPRESS: 1800,
});
const INPUT_KEYS = 'discountBps|quantity|shipping';
export function previewQuote(input: unknown): DemoQuote {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('DEMO_INVALID_INPUT');
  }
  const source = input as Record<string, unknown>;
  if (Object.keys(source).sort().join('|') !== INPUT_KEYS ||
      !Number.isSafeInteger(source.quantity) ||
      (source.quantity as number) < 1 || (source.quantity as number) > 5 ||
      !Number.isSafeInteger(source.discountBps) ||
      (source.discountBps as number) < 0 || (source.discountBps as number) > 10000 ||
      (source.shipping !== 'STANDARD' && source.shipping !== 'EXPRESS')) {
    throw new Error('DEMO_INVALID_INPUT');
  }
  const quantity = source.quantity as number;
  const discountBps = source.discountBps as number;
  const shipping = source.shipping as DemoShipping;
  const subtotalCents = UNIT_CENTS * quantity;
  // Integer math only. Eligible offers use nearest-cent rounding.
  const eligible = discountBps <= MAX_DISCOUNT_BPS;
  const discountCents = eligible
    ? Math.floor((subtotalCents * discountBps + 5000) / 10000)
    : 0;
  const shippingCents = SHIPPING_CENTS[shipping];
  return Object.freeze({
    quantity, shipping, unitCents: UNIT_CENTS, subtotalCents,
    discountCents, shippingCents, discountBps, eligible,
    totalCents: subtotalCents - discountCents + shippingCents,
  });
}
export function money(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error('DEMO_INVALID_MONEY');
  }
  return (cents / 100).toFixed(2);
}
