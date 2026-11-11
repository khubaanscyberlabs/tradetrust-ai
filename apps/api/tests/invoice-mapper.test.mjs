import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  proposeQuote,
} from '../src/domain/quote.ts';

import {
  mapStoredQuoteToInvoiceDraft,
} from '../src/paypal/invoice-mapper.ts';

function storedFrom(snapshot) {
  const json = JSON.stringify(snapshot);

  return {
    quote_id: 'synthetic-quote-01',
    currency: snapshot.currency,
    subtotal_cents: snapshot.subtotalCents,
    discount_cents: snapshot.discountCents,
    shipping_cents: snapshot.shippingCents,
    total_cents: snapshot.totalCents,
    snapshot_json: json,
    snapshot_sha256: createHash('sha256')
      .update(json).digest('hex'),
  };
}

const sample = () => proposeQuote({
  items: [{ sku: 'OUTFIT-01', quantity: 2 }],
  shipping: 'standard',
});

const discounted = () => proposeQuote({
  items: [
    { sku: 'OUTFIT-01', quantity: 2 },
    { sku: 'SCARF-01', quantity: 1 },
  ],
  shipping: 'express',
  discountBps: 333,
});

async function denied(row) {
  await assert.rejects(
    mapStoredQuoteToInvoiceDraft(row),
    /PAYPAL_INVOICE_MAPPING_REJECTED/,
  );
}

test('maps the stored $109 quote exactly', async () => {
  const result = await mapStoredQuoteToInvoiceDraft(
    storedFrom(sample()),
  );

  assert.equal(result.expectedTotal.value, '109.00');
  assert.equal(result.draftFinancials.items.length, 1);

  const item = result.draftFinancials.items[0];

  assert.equal(item.quantity, '2');
  assert.equal(item.name, 'Embroidered Outfit');
  assert.equal(item.unit_amount.value, '42.00');

  assert.equal(
    result.draftFinancials
      .amount.breakdown.shipping.amount.value,
    '25.00',
  );

  assert.equal(
    result.draftFinancials.amount.breakdown.discount,
    undefined,
  );

  assert.equal(
    result.draftFinancials.amount.value,
    undefined,
  );
});

test('maps multi-line fixed discount without rounding drift', async () => {
  const quote = discounted();
  const result = await mapStoredQuoteToInvoiceDraft(
    storedFrom(quote),
  );

  assert.equal(quote.subtotalCents, 10200);
  assert.equal(quote.discountCents, 339);
  assert.equal(quote.totalCents, 16361);

  assert.equal(result.expectedTotal.value, '163.61');
  assert.equal(result.draftFinancials.items.length, 2);

  assert.equal(
    result.draftFinancials
      .amount.breakdown.discount
      .invoice_discount.amount.value,
    '3.39',
  );

  assert.equal(
    result.draftFinancials
      .amount.breakdown.shipping.amount.value,
    '65.00',
  );
});

test('rejects tampered snapshot bytes', async () => {
  const row = storedFrom(sample());

  await denied({
    ...row,
    snapshot_json:
      row.snapshot_json.replace('10900', '100'),
  });
});

test('rejects a forged digest', async () => {
  await denied({
    ...storedFrom(sample()),
    snapshot_sha256: 'a'.repeat(64),
  });
});

test('rejects persisted total disagreement', async () => {
  const row = storedFrom(sample());
  await denied({ ...row, total_cents: 1 });
});

test('rejects inconsistent line prices', async () => {
  const quote = JSON.parse(JSON.stringify(sample()));
  quote.lines[0].lineCents = 1;

  await denied(storedFrom(quote));
});

test('rejects discount-rounding mismatch', async () => {
  const quote =
    JSON.parse(JSON.stringify(discounted()));

  quote.discountCents += 1;
  quote.totalCents -= 1;

  await denied(storedFrom(quote));
});

test('rejects unapproved financial fields', async () => {
  const quote = {
    ...sample(),
    buyerTotalCents: 1,
  };

  await denied(storedFrom(quote));
});

test('rejects duplicate product lines', async () => {
  const quote = JSON.parse(JSON.stringify(sample()));
  quote.lines.push({ ...quote.lines[0] });
  quote.subtotalCents *= 2;
  quote.totalCents += 8400;

  await denied(storedFrom(quote));
});

test('rejects malformed stored JSON', async () => {
  const row = storedFrom(sample());

  await denied({
    ...row,
    snapshot_json: '{',
  });
});

test('rejects unsupported currency', async () => {
  const row = storedFrom(sample());
  await denied({ ...row, currency: 'INR' });
});

test('rejects zero or unsafe financial amounts', async () => {
  const quote = JSON.parse(JSON.stringify(sample()));
  quote.totalCents = 0;
  await denied(storedFrom(quote));
});
