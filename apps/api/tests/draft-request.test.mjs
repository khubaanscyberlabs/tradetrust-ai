import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  proposeQuote,
} from '../src/domain/quote.ts';

import {
  composeDraftRequest,
} from '../src/paypal/draft-request.ts';

function context(overrides = {}) {
  const quote = proposeQuote({
    items: [
      { sku: 'OUTFIT-01', quantity: 2 },
    ],
    shipping: 'standard',
  });

  const json = JSON.stringify(quote);
  const hash = createHash('sha256')
    .update(json).digest('hex');

  return {
    merchantId: 'merchant-A',

    approval: {
      id: 'approval-001',
      merchant_id: 'merchant-A',
      quote_id: 'quote-A',
      revision_no: 1,
      snapshot_sha256: hash,
    },

    stored: {
      quote_id: 'quote-A',
      currency: 'USD',
      subtotal_cents: quote.subtotalCents,
      discount_cents: quote.discountCents,
      shipping_cents: quote.shippingCents,
      total_cents: quote.totalCents,
      snapshot_json: json,
      snapshot_sha256: hash,
    },

    invoicerEmail: 'seller@example.test',
    invoicerBusinessName: 'Synthetic Merchant',
    buyerEmail: 'buyer@example.test',

    ...overrides,
  };
}

async function denied(value) {
  await assert.rejects(
    composeDraftRequest(value),
    /PAYPAL_DRAFT_CONTEXT_REJECTED|PAYPAL_INVOICE_MAPPING_REJECTED/,
  );
}

test('creates complete USD draft request', async () => {
  const result = await composeDraftRequest(context());

  assert.equal(result.expectedTotal.value, '109.00');
  assert.equal(result.draftBody.detail.currency_code, 'USD');
  assert.equal(
    result.draftBody.detail.payment_term.term_type,
    'DUE_ON_RECEIPT',
  );

  assert.equal(
    result.draftBody.primary_recipients[0]
      .billing_info.email_address,
    'buyer@example.test',
  );

  assert.equal(result.draftBody.items.length, 1);
  assert.equal(
    result.draftBody.amount.breakdown
      .shipping.amount.value,
    '25.00',
  );

  assert.equal(
    result.draftBody.configuration.allow_tip,
    false,
  );

  assert.equal(
    result.draftBody.configuration
      .partial_payment.allow_partial_payment,
    false,
  );

  assert.equal(
    result.draftBody.amount.value,
    undefined,
  );

  assert.equal(
    'expectedTotal' in result.draftBody,
    false,
  );
});

test('preserves fixed discount and express shipping', async () => {
  const quote = proposeQuote({
    items: [
      { sku: 'OUTFIT-01', quantity: 2 },
      { sku: 'SCARF-01', quantity: 1 },
    ],
    shipping: 'express',
    discountBps: 333,
  });

  const json = JSON.stringify(quote);
  const hash = createHash('sha256')
    .update(json).digest('hex');

  const baseline = context();

  const result = await composeDraftRequest({
    ...baseline,
    stored: {
      ...baseline.stored,
      subtotal_cents: quote.subtotalCents,
      discount_cents: quote.discountCents,
      shipping_cents: quote.shippingCents,
      total_cents: quote.totalCents,
      snapshot_json: json,
      snapshot_sha256: hash,
    },
    approval: {
      ...baseline.approval,
      snapshot_sha256: hash,
    },
  });

  assert.equal(result.expectedTotal.value, '163.61');
  assert.equal(
    result.draftBody.amount.breakdown
      .discount.invoice_discount.amount.value,
    '3.39',
  );
});

test('invoice number is stable and under 25 chars', async () => {
  const a = await composeDraftRequest(context());
  const b = await composeDraftRequest(context());

  assert.equal(a.invoiceNumber, b.invoiceNumber);
  assert.match(a.invoiceNumber, /^TT-[a-f0-9]{20}$/);
  assert.equal(a.invoiceNumber.length, 23);
});

test('different approval produces different number', async () => {
  const initial = context();
  const a = await composeDraftRequest(initial);

  const b = await composeDraftRequest({
    ...initial,
    approval: {
      ...initial.approval,
      id: 'approval-002',
    },
  });

  assert.notEqual(a.invoiceNumber, b.invoiceNumber);
});

test('rejects cross-merchant approval', async () => {
  const value = context();

  await denied({
    ...value,
    approval: {
      ...value.approval,
      merchant_id: 'merchant-B',
    },
  });
});

test('rejects approval for another quote', async () => {
  const value = context();

  await denied({
    ...value,
    approval: {
      ...value.approval,
      quote_id: 'quote-B',
    },
  });
});

test('rejects mismatched approved digest', async () => {
  const value = context();

  await denied({
    ...value,
    approval: {
      ...value.approval,
      snapshot_sha256: 'a'.repeat(64),
    },
  });
});

test('rejects tampered quote JSON', async () => {
  const value = context();

  await denied({
    ...value,
    stored: {
      ...value.stored,
      snapshot_json:
        value.stored.snapshot_json.replace(
          '10900', '100',
        ),
    },
  });
});

test('rejects invalid merchant email', async () => {
  await denied(context({
    invoicerEmail: 'invalid-email',
  }));
});

test('rejects invalid buyer email', async () => {
  await denied(context({
    buyerEmail: 'buyer@@example.test',
  }));
});

test('rejects sender and buyer being identical', async () => {
  await denied(context({
    buyerEmail: 'SELLER@example.test',
  }));
});

test('rejects missing approval', async () => {
  await denied(context({ approval: null }));
});
