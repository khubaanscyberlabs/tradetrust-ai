/**
 * TradeTrust AI — PayPal Invoicing v2 financial mapper.
 *
 * Maps a stored, hash-verified quote revision into
 * invoice financial fields.
 *
 * Does NOT establish merchant approval.
 * Does NOT create, send, or pay an invoice.
 * Caller must independently verify approval in D1.
 */

export type StoredQuoteRevision = Readonly<{
  quote_id: string;
  currency: string;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  total_cents: number;
  snapshot_json: string;
  snapshot_sha256: string;
}>;

type QuoteLine = {
  sku: string;
  name: string;
  quantity: number;
  unitCents: number;
  lineCents: number;
};

type QuoteSnapshot = {
  currency: string;
  status: string;
  lines: QuoteLine[];
  discountBps: number;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
};

const MAX_CENTS = 100_000_000;

const SNAPSHOT_KEYS = [
  'currency',
  'discountBps',
  'discountCents',
  'lines',
  'shippingCents',
  'status',
  'subtotalCents',
  'totalCents',
].sort().join('|');

const LINE_KEYS = [
  'lineCents',
  'name',
  'quantity',
  'sku',
  'unitCents',
].sort().join('|');

function reject(): never {
  throw Error('PAYPAL_INVOICE_MAPPING_REJECTED');
}

function object(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) ===
      Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string,
): boolean {
  return Object.keys(value).sort().join('|') === expected;
}

function cents(
  value: unknown,
  minimum = 0,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= MAX_CENTS
  );
}

function money(value: number) {
  if (!cents(value)) reject();

  return Object.freeze({
    currency_code: 'USD' as const,
    value:
      `${Math.floor(value / 100)}.` +
      String(value % 100).padStart(2, '0'),
  });
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(hash))
    .map(n => n.toString(16).padStart(2, '0'))
    .join('');
}

export async function mapStoredQuoteToInvoiceDraft(
  stored: StoredQuoteRevision,
) {
  if (
    !stored ||
    typeof stored.quote_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
      .test(stored.quote_id) ||
    stored.currency !== 'USD' ||
    typeof stored.snapshot_json !== 'string' ||
    stored.snapshot_json.length < 2 ||
    stored.snapshot_json.length > 32768 ||
    typeof stored.snapshot_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(stored.snapshot_sha256)
  ) {
    reject();
  }

  const actualHash = await digest(stored.snapshot_json);

  if (actualHash !== stored.snapshot_sha256) {
    reject();
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(stored.snapshot_json);
  } catch {
    reject();
  }

  if (
    !object(decoded) ||
    !exactKeys(decoded, SNAPSHOT_KEYS) ||
    decoded.currency !== 'USD' ||
    decoded.status !==
      'PROPOSAL_REQUIRES_MERCHANT_APPROVAL' ||
    !Array.isArray(decoded.lines) ||
    decoded.lines.length < 1 ||
    decoded.lines.length > 10 ||
    !Number.isInteger(decoded.discountBps) ||
    (decoded.discountBps as number) < 0 ||
    (decoded.discountBps as number) > 1000
  ) {
    reject();
  }

  const quote =
    decoded as unknown as QuoteSnapshot;

  if (
    !cents(quote.subtotalCents, 1) ||
    !cents(quote.discountCents) ||
    !cents(quote.shippingCents) ||
    !cents(quote.totalCents, 1)
  ) {
    reject();
  }

  const seen = new Set<string>();
  let calculatedSubtotal = 0;

  const items = quote.lines.map(line => {
    if (
      !object(line) ||
      !exactKeys(line, LINE_KEYS) ||
      typeof line.sku !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
        .test(line.sku) ||
      seen.has(line.sku) ||
      typeof line.name !== 'string' ||
      line.name.length < 1 ||
      line.name.length > 200 ||
      line.name.trim() !== line.name ||
      /[\u0000-\u001f\u007f]/.test(line.name) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 1000000 ||
      !cents(line.unitCents, 1) ||
      !cents(line.lineCents, 1)
    ) {
      reject();
    }

    if (
      line.unitCents * line.quantity !==
      line.lineCents
    ) {
      reject();
    }

    seen.add(line.sku);

    calculatedSubtotal += line.lineCents;

    if (!cents(calculatedSubtotal, 1)) {
      reject();
    }

    return Object.freeze({
      name: line.name,
      description: `SKU: ${line.sku}`,
      quantity: String(line.quantity),
      unit_amount: money(line.unitCents),
      unit_of_measure: 'QUANTITY' as const,
    });
  });

  const expectedDiscount = Math.floor(
    quote.subtotalCents * quote.discountBps /
    10000,
  );

  if (
    calculatedSubtotal !== quote.subtotalCents ||
    expectedDiscount !== quote.discountCents ||
    quote.discountCents > quote.subtotalCents ||
    quote.totalCents !==
      quote.subtotalCents -
      quote.discountCents +
      quote.shippingCents ||
    stored.subtotal_cents !== quote.subtotalCents ||
    stored.discount_cents !== quote.discountCents ||
    stored.shipping_cents !== quote.shippingCents ||
    stored.total_cents !== quote.totalCents
  ) {
    reject();
  }

  const breakdown: Record<string, unknown> = {};

  if (quote.discountCents > 0) {
    breakdown.discount = {
      invoice_discount: {
        amount: money(quote.discountCents),
      },
    };
  }

  if (quote.shippingCents > 0) {
    breakdown.shipping = {
      amount: money(quote.shippingCents),
    };
  }

  const financials = {
    detail: {
      currency_code: 'USD' as const,
      reference: stored.quote_id,
    },
    items: Object.freeze(items),
    ...(Object.keys(breakdown).length > 0
      ? { amount: { breakdown } }
      : {}),
  };

  return Object.freeze({
    draftFinancials: financials,
    verifiedSnapshotSha256: actualHash,
    expectedTotal: money(quote.totalCents),
  });
}
