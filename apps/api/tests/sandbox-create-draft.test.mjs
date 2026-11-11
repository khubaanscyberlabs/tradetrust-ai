import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxDraftMockOnly } from '../src/paypal/sandbox-create-draft.ts';

const ENV = Object.freeze({
  PAYPAL_ENVIRONMENT: 'SANDBOX',
  PAYPAL_DRAFT_CREATE_MODE: 'MOCK_ONLY',
  PAYPAL_CLIENT_ID: 'sandbox-id',
  PAYPAL_CLIENT_SECRET: 'test-only-not-a-real-secret',
  PAYPAL_SANDBOX_MERCHANT_EMAIL: 'seller@example.test',
});
const SCOPE = 'https://uri.paypal.com/services/invoicing/invoices/readwrite';
const INVOICE_ID = 'INV2-TEST-1234-5678-ABCD';
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NUMBER = 'TT-1234567890abcdef1234';

async function fixture() {
  const draftBody = {
    detail: { invoice_number: NUMBER, currency_code: 'USD', payment_term: { term_type: 'DUE_ON_RECEIPT' } },
    invoicer: { email_address: 'seller@example.test', business_name: 'Trusted Seller' },
    primary_recipients: [{ billing_info: { email_address: 'buyer@example.test' } }],
    items: [{ name: 'TradeTrust Outfit', quantity: '1', unit_amount: { currency_code: 'USD', value: '109.00' } }],
    configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
  };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(draftBody)));
  const requestBodySha256 = Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2,'0')).join('');
  return { status: 'UNCERTAIN', paypalRequestId: REQUEST_ID, requestBodySha256, invoiceNumber: NUMBER,
    expectedTotal: { currency_code: 'USD', value: '109.00' }, draftBody };
}

function mock(ticket, change = {}) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url: String(url), ...options });
    const suffix = new URL(url).pathname;
    if (change.throwOn === suffix) throw Error('SECRET: simulated transport failure');
    if (suffix === '/v1/oauth2/token') {
      return new Response(JSON.stringify(change.authPayload ?? {
        access_token: 'synthetic-token', token_type: 'Bearer', scope: SCOPE,
      }), { status: change.authStatus ?? 200 });
    }
    if (suffix === '/v2/invoicing/invoices' && options.method === 'POST') {
      return new Response(JSON.stringify(change.createPayload ?? { id: INVOICE_ID }),
        { status: change.createStatus ?? 201 });
    }
    if (suffix === '/v2/invoicing/invoices/' + INVOICE_ID) {
      const original = ticket.draftBody;
      const payload = {
        id: INVOICE_ID, status: 'DRAFT', detail: original.detail,
        amount: { currency_code: 'USD', value: '109.00' },
        invoicer: original.invoicer, primary_recipients: original.primary_recipients,
        items: original.items,
        ...change.fetchFields,
      };
      return new Response(JSON.stringify(change.getPayload ?? payload),
        { status: change.getStatus ?? 200 });
    }
    throw Error('UNEXPECTED_API_REQUEST');
  };
  return { calls, transport };
}

async function denied(error, make) {
  const ticket = await fixture();
  const m = mock(ticket);
  await assert.rejects(make(ticket, m), new RegExp(error));
  return m;
}

test('successful mocked create verifies OAuth, POST, read-back and exact $109', async () => {
  const ticket = await fixture();
  const m = mock(ticket);
  const value = await createSandboxDraftMockOnly(ENV, ticket, m.transport);
  assert.deepEqual(value, { invoiceId: INVOICE_ID, invoiceNumber: NUMBER,
    currencyCode: 'USD', totalValue: '109.00', status: 'DRAFT' });
  assert.equal(m.calls.length, 3);
  assert.deepEqual(m.calls.map(x => x.method), ['POST','POST','GET']);
  assert.ok(m.calls.every(x => x.url.startsWith('https://api-m.sandbox.paypal.com/')));
  assert.equal(new Headers(m.calls[1].headers).get('PayPal-Request-Id'), REQUEST_ID);
  assert.deepEqual(JSON.parse(m.calls[1].body), ticket.draftBody);
  assert.equal(new Headers(m.calls[1].headers).get('Authorization'), 'Bearer synthetic-token');
  assert.ok(m.calls.every(x => x.redirect === 'error' && x.signal));
});

test('requires explicit MOCK_ONLY gate and makes no requests', async () => {
  const m = await denied('PAYPAL_DRAFT_CREATE_DISABLED', (ticket, x) =>
    createSandboxDraftMockOnly({ ...ENV, PAYPAL_DRAFT_CREATE_MODE: undefined }, ticket, x.transport));
  assert.equal(m.calls.length, 0);
});

test('rejects LIVE before network access', async () => {
  const m = await denied('PAYPAL_SANDBOX_ONLY', (ticket, x) =>
    createSandboxDraftMockOnly({ ...ENV, PAYPAL_ENVIRONMENT: 'LIVE' }, ticket, x.transport));
  assert.equal(m.calls.length, 0);
});

test('rejects missing injected transport', async () => {
  const ticket = await fixture();
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, undefined), /PAYPAL_DRAFT_TRANSPORT_REQUIRED/);
});

test('rejects missing Sandbox credentials before network', async () => {
  const m = await denied('PAYPAL_DRAFT_CREDENTIALS_INVALID', (ticket, x) =>
    createSandboxDraftMockOnly({ ...ENV, PAYPAL_CLIENT_SECRET: undefined }, ticket, x.transport));
  assert.equal(m.calls.length, 0);
});

test('rejects missing trusted merchant email before network', async () => {
  const m = await denied('PAYPAL_DRAFT_CREDENTIALS_INVALID', (ticket, x) =>
    createSandboxDraftMockOnly({ ...ENV, PAYPAL_SANDBOX_MERCHANT_EMAIL: undefined }, ticket, x.transport));
  assert.equal(m.calls.length, 0);
});

test('rejects PREPARED ticket (D1 claim required)', async () => {
  const m = await denied('PAYPAL_DRAFT_TICKET_REJECTED', (ticket, x) =>
    createSandboxDraftMockOnly(ENV, { ...ticket, status: 'PREPARED' }, x.transport));
  assert.equal(m.calls.length, 0);
});

test('rejects malformed PayPal-Request-Id', async () => {
  const m = await denied('PAYPAL_DRAFT_TICKET_REJECTED', (ticket, x) =>
    createSandboxDraftMockOnly(ENV, { ...ticket, paypalRequestId: 'forged' }, x.transport));
  assert.equal(m.calls.length, 0);
});

test('rejects changed invoice payload after digest', async () => {
  const m = await denied('PAYPAL_DRAFT_TICKET_REJECTED', (ticket, x) =>
    createSandboxDraftMockOnly(ENV, { ...ticket, draftBody: {
      ...ticket.draftBody, items: [{ ...ticket.draftBody.items[0],
        unit_amount: { currency_code: 'USD', value: '1.00' } }],
    } }, x.transport));
  assert.equal(m.calls.length, 0);
});

test('rejects forged local invoice total', async () => {
  const m = await denied('PAYPAL_DRAFT_TICKET_REJECTED', (ticket, x) =>
    createSandboxDraftMockOnly(ENV, { ...ticket, expectedTotal: { currency_code: 'USD', value: '1.00' },
      draftBody: { ...ticket.draftBody, amount: { currency_code: 'USD', value: '109.00' } } }, x.transport));
  assert.equal(m.calls.length, 0);
});

test('rejects untrusted invoicer email even with otherwise valid snapshot', async () => {
  const ticket = await fixture();
  ticket.draftBody.invoicer.email_address = 'attacker@example.test';
  const m = mock(ticket);
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_TICKET_REJECTED/);
  assert.equal(m.calls.length, 0);
});

test('rejects buyer email equal to merchant', async () => {
  const ticket = await fixture();
  ticket.draftBody.primary_recipients[0].billing_info.email_address = 'seller@example.test';
  const m = mock(ticket);
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_TICKET_REJECTED/);
  assert.equal(m.calls.length, 0);
});

test('rejects missing invoice readwrite scope before creation', async () => {
  const ticket = await fixture();
  const m = mock(ticket, { authPayload: { token_type:'Bearer', access_token:'token',
    scope: 'https://uri.paypal.com/services/invoicing/invoices/read' } });
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_OAUTH_SCOPE_REJECTED/);
  assert.equal(m.calls.length, 1);
});

test('rejects OAuth failure before creation', async () => {
  const ticket = await fixture(); const m = mock(ticket, {authStatus:401});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_OAUTH_REJECTED/);
  assert.equal(m.calls.length, 1);
});

test('sanitizes OAuth network error', async () => {
  const ticket = await fixture(); const m = mock(ticket, {throwOn:'/v1/oauth2/token'});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), err =>
    err.message === 'PAYPAL_DRAFT_NETWORK_UNCERTAIN');
  assert.equal(m.calls.length, 1);
});

test('create timeout requires reconciliation, never retries', async () => {
  const ticket = await fixture(); const m = mock(ticket, {throwOn:'/v2/invoicing/invoices'});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_RECONCILIATION_REQUIRED/);
  assert.equal(m.calls.length, 2);
});

test('create conflict requires reconciliation, never retries', async () => {
  const ticket = await fixture(); const m = mock(ticket, {createStatus:409});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_RECONCILIATION_REQUIRED/);
  assert.equal(m.calls.length, 2);
});

test('201 without valid invoice ID requires reconciliation', async () => {
  const ticket = await fixture(); const m = mock(ticket, {createPayload: {id:'fake-id'}});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_RECONCILIATION_REQUIRED/);
  assert.equal(m.calls.length, 2);
});

test('GET failure requires reconciliation', async () => {
  const ticket = await fixture(); const m = mock(ticket, {getStatus:503});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_RECONCILIATION_REQUIRED/);
  assert.equal(m.calls.length, 3);
});

test('GET returns wrong amount: reconciliation required', async () => {
  const ticket = await fixture(); const m = mock(ticket, {fetchFields:{amount:{currency_code:'USD', value:'1.00'}}});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_RECONCILIATION_REQUIRED/);
});

test('GET returns other buyer: reconciliation required', async () => {
  const ticket = await fixture(); const m = mock(ticket, {fetchFields:{primary_recipients:[{billing_info:{email_address:'wrong@example.test'}}]}});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_RECONCILIATION_REQUIRED/);
});

test('GET returns other merchant: reconciliation required', async () => {
  const ticket = await fixture(); const m = mock(ticket, {fetchFields:{invoicer:{email_address:'wrong@example.test'}}});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_RECONCILIATION_REQUIRED/);
});

test('GET returns SENT status: reconciliation required', async () => {
  const ticket = await fixture(); const m = mock(ticket, {fetchFields:{status:'SENT'}});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_RECONCILIATION_REQUIRED/);
});

test('GET line differs from approved body: reconciliation required', async () => {
  const ticket = await fixture(); const m = mock(ticket, {fetchFields:{items:[{name:'Other', quantity:'1', unit_amount:{currency_code:'USD',value:'109.00'}}]}});
  await assert.rejects(createSandboxDraftMockOnly(ENV, ticket, m.transport), /PAYPAL_DRAFT_RECONCILIATION_REQUIRED/);
});
