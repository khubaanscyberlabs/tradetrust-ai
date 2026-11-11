import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeQuote } from '../src/domain/quote.ts';

const base = () => ({
  items: [{ sku: 'OUTFIT-01', quantity: 2 }],
  shipping: 'standard',
});

test('trusted inventory determines financial amounts', () => {
  const q = proposeQuote(base());

  assert.equal(q.subtotalCents, 8400);
  assert.equal(q.shippingCents, 2500);
  assert.equal(q.totalCents, 10900);
  assert.equal(
    q.status,
    'PROPOSAL_REQUIRES_MERCHANT_APPROVAL',
  );
});

test('discount uses integer basis points', () => {
  const q = proposeQuote({
    ...base(),
    discountBps: 500,
  });

  assert.equal(q.discountCents, 420);
  assert.equal(q.totalCents, 10480);
});

test('rejects AI price overrides', () => {
  assert.throws(
    () => proposeQuote({
      ...base(),
      items: [{
        sku: 'OUTFIT-01',
        quantity: 2,
        unitCents: 100,
      }],
    }),
    /Unexpected field/,
  );
});

test('rejects client-supplied totals', () => {
  assert.throws(
    () => proposeQuote({ ...base(), totalCents: 100 }),
    /Unexpected field/,
  );
});

test('rejects unauthorized discounts', () => {
  assert.throws(
    () => proposeQuote({ ...base(), discountBps: 1100 }),
    /Discount/,
  );
});

test('rejects inventory oversell', () => {
  assert.throws(
    () => proposeQuote({
      ...base(),
      items: [{ sku: 'OUTFIT-01', quantity: 101 }],
    }),
    /quantity/,
  );
});

test('rejects fractional and negative quantities', () => {
  for (const quantity of [1.5, 0, -1]) {
    assert.throws(
      () => proposeQuote({
        ...base(),
        items: [{ sku: 'OUTFIT-01', quantity }],
      }),
      /quantity/,
    );
  }
});

test('rejects duplicate products', () => {
  assert.throws(
    () => proposeQuote({
      ...base(),
      items: [base().items[0], base().items[0]],
    }),
    /Duplicate/,
  );
});

test('rejects unknown SKUs and shipping', () => {
  assert.throws(
    () => proposeQuote({
      ...base(),
      items: [{ sku: 'MISSING', quantity: 1 }],
    }),
    /Unknown/,
  );

  assert.throws(
    () => proposeQuote({ ...base(), shipping: 'free' }),
    /shipping/,
  );
});

test('proposal and line records are immutable', () => {
  const q = proposeQuote(base());

  assert.ok(Object.isFrozen(q));
  assert.ok(Object.isFrozen(q.lines));
  assert.ok(Object.isFrozen(q.lines[0]));
});
