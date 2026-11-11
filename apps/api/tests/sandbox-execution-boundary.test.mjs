import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSandboxExecutionOffline } from '../src/paypal/sandbox-execution-boundary.ts';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const req = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const invoice = 'TT-1234567890abcdef1234';
const validBody = () => ({
  detail: { invoice_number: invoice, currency_code: 'USD', payment_term: { term_type: 'DUE_ON_RECEIPT' } },
  invoicer: { email_address: 'seller@example.test', business_name: 'Example Seller' },
  primary_recipients: [{ billing_info: { email_address: 'buyer@example.test' } }],
  items: [{ name: 'Test Product', quantity: '1', unit_amount: { currency_code: 'USD', value: '109.00' } }],
  amount: { currency_code: 'USD', value: '109.00' },
  configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
});
async function fixture() {
  const draftBody = validBody();
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(draftBody)));
  const digest = [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
  return {
    env: { PAYPAL_ENVIRONMENT: 'SANDBOX', TRADETRUST_SANDBOX_EXECUTION_MODE: 'OFFLINE_VALIDATE_ONLY' },
    binding: { merchantId: 'merchant-a', approvalId: 'approval-a' },
    prepared: {
      status: 'PREPARED', paymentInitiated: false, operationId: id, paypalRequestId: req,
      invoiceNumber: invoice, expectedTotal: { currency_code: 'USD', value: '109.00' }, draftBody: structuredClone(draftBody),
    },
    claimed: { operationId: id, merchantId: 'merchant-a', approvalId: 'approval-a', ticket: {
      status: 'UNCERTAIN', paypalRequestId: req, invoiceNumber: invoice,
      requestBodySha256: digest, expectedTotal: { currency_code: 'USD', value: '109.00' },
      draftBody,
    } },
    parties: { source: 'TRUSTED_SERVER_RECORD', merchantId: 'merchant-a',
      invoicerEmail: 'seller@example.test', invoicerBusinessName: 'Example Seller', buyerEmail: 'buyer@example.test' },
  };
}

async function denied(name, change) {
  const x = await fixture();
  change(x);
  await assert.rejects(validateSandboxExecutionOffline(x), /SANDBOX_EXECUTION_BOUNDARY_REJECTED/, name);
}

test('valid offline claimed operation returns non-authorizing evidence', async () => {
  const x = await fixture();
  const result = await validateSandboxExecutionOffline(x);
  assert.equal(result.state, 'OFFLINE_VALIDATED_ONLY');
  assert.equal(result.networkAllowed, false);
  assert.equal(result.paymentInitiated, false);
  assert.equal(result.operationId, id);
  assert.equal(result.requestBodySha256, x.claimed.ticket.requestBodySha256);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.total));
  assert.ok(!('buyerEmail' in result) && !('invoicerEmail' in result));
});

test('offline validation never contacts global fetch', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw Error('UNEXPECTED_NETWORK'); };
    await validateSandboxExecutionOffline(await fixture());
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

const adversarial = [
  ['disabled by default', x => { delete x.env.TRADETRUST_SANDBOX_EXECUTION_MODE; }],
  ['explicit live mode refused', x => { x.env.TRADETRUST_SANDBOX_EXECUTION_MODE = 'LIVE'; }],
  ['live PayPal environment refused', x => { x.env.PAYPAL_ENVIRONMENT = 'LIVE'; }],
  ['unrecognized Sandbox environment refused', x => { x.env.PAYPAL_ENVIRONMENT = 'SANDBOX-ALT'; }],
  ['wrong merchant in claimed operation', x => { x.claimed.merchantId = 'merchant-b'; }],
  ['wrong approval in claimed operation', x => { x.claimed.approvalId = 'approval-b'; }],
  ['wrong claimed operation ID', x => { x.claimed.operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; }],
  ['incorrect PayPal request id', x => { x.claimed.ticket.paypalRequestId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; }],
  ['invoice number mismatch', x => { x.claimed.ticket.invoiceNumber = 'TT-ffffffffffffffffffff'; }],
  ['prepared not PREPARED', x => { x.prepared.status = 'UNCERTAIN'; }],
  ['payment initiated', x => { x.prepared.paymentInitiated = true; }],
  ['unclaimed ticket', x => { x.claimed.ticket.status = 'PREPARED'; }],
  ['incorrect amount', x => { x.claimed.ticket.expectedTotal.value = '110.00'; }],
  ['zero amount', x => { x.prepared.expectedTotal.value = '0.00'; x.claimed.ticket.expectedTotal.value = '0.00'; }],
  ['currency mismatch', x => { x.prepared.expectedTotal.currency_code = 'EUR'; }],
  ['tampered digest', x => { x.claimed.ticket.requestBodySha256 = '0'.repeat(64); }],
  ['mutated claimed body', x => { x.claimed.ticket.draftBody.items[0].name = 'Changed'; }],
  ['bad payer provenance', x => { x.parties.source = 'BROWSER_FORM'; }],
  ['merchant party mismatch', x => { x.parties.merchantId = 'merchant-b'; }],
  ['wrong buyer email', x => { x.parties.buyerEmail = 'someone@example.test'; }],
  ['buyer equals seller', x => { x.parties.buyerEmail = 'seller@example.test'; }],
  ['wrong merchant email', x => { x.parties.invoicerEmail = 'attacker@example.test'; }],
  ['wrong merchant business name', x => { x.parties.invoicerBusinessName = 'Fake Seller'; }],
  ['extra party field blocked', x => { x.parties.browserOverride = true; }],
  ['wrong body amount', x => { x.claimed.ticket.draftBody.amount.value = '1.00'; }],
  ['missing line items', x => { x.claimed.ticket.draftBody.items = []; }],
  ['payment tip turned on', x => { x.claimed.ticket.draftBody.configuration.allow_tip = true; }],
  ['partial payment turned on', x => { x.claimed.ticket.draftBody.configuration.partial_payment.allow_partial_payment = true; }],
  ['malformed operation UUID', x => { x.prepared.operationId = 'not-a-uuid'; }],
  ['malformed buyer email', x => { x.parties.buyerEmail = 'bad\r\nmail@example.test'; }],
];
for (const [name, modify] of adversarial) {
  test(`fail-closed: ${name}`, async () => denied(name, modify));
}
