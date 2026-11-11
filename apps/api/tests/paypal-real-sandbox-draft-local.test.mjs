import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSandboxDraftRealSandboxOnce } from '../src/paypal/sandbox-create-draft.ts';
import { executeOneRealSandboxDraftLocal } from '../src/paypal/real-sandbox-draft-local.ts';

const request = (path = 'http://127.0.0.1:8787/api/merchant/demo', origin = 'http://127.0.0.1:8787', method = 'POST') =>
  new Request(path, { method, headers: { Origin: origin } });
const keys = { merchantId: 'merchant-local-demo', approvalId: 'approved-local' };
const full = {
  TRADETRUST_AUTH_MODE: 'LOCAL_SESSION', PAYPAL_ENVIRONMENT: 'SANDBOX',
  PAYPAL_DRAFT_CREATE_MODE: 'SANDBOX_REAL_ONE_DRAFT',
  TRADETRUST_SANDBOX_EXECUTION_MODE: 'LOCAL_SANDBOX_DRAFT_ONESHOT',
};
let externalCalls = 0;
const forbiddenTransport = async () => { externalCalls++; throw Error('NETWORK_MUST_NOT_BE_USED'); };

for (const [label, patch] of [
  ['missing gates', {}],
  ['live environment', {...full, PAYPAL_ENVIRONMENT: 'LIVE'}],
  ['mock create mode', {...full, PAYPAL_DRAFT_CREATE_MODE: 'MOCK_ONLY'}],
  ['wrong identity mode', {...full, TRADETRUST_AUTH_MODE: 'CLOUDFLARE_ACCESS'}],
  ['missing execution authorization', {...full, TRADETRUST_SANDBOX_EXECUTION_MODE: undefined}],
]) {
  test('real draft adapter fails closed: ' + label, async () => {
    await assert.rejects(createSandboxDraftRealSandboxOnce(patch, {}, forbiddenTransport),
      /PAYPAL_DRAFT_REAL_SANDBOX_DISABLED/);
    assert.equal(externalCalls, 0);
  });
}

test('internal workflow requires enabled local D1 before any external calls', async () => {
  await assert.rejects(executeOneRealSandboxDraftLocal(request(), full, keys, forbiddenTransport),
    /PAYPAL_REAL_SANDBOX_LOCAL_DENIED/);
  assert.equal(externalCalls, 0);
});

test('internal workflow rejects cross-origin requests before D1 or PayPal', async () => {
  await assert.rejects(executeOneRealSandboxDraftLocal(request('http://evil.example/api', 'http://evil.example'),
    {...full, DB: { prepare() { throw Error('DB_NOT_ALLOWED'); } }}, keys, forbiddenTransport),
    /PAYPAL_REAL_SANDBOX_LOCAL_DENIED/);
  assert.equal(externalCalls, 0);
});

test('claim must check latest quote revision inside atomic update', () => {
  const ledger = readFileSync(new URL('../src/paypal/draft-operation-ledger.ts', import.meta.url), 'utf8');
  assert.match(ledger, /AND r\.revision_no\s*=\s*\(\s*SELECT MAX\(z\.revision_no\)/);
});

test('newly gated Sandbox transport passes one simulated OAuth/create/readback using same exact $109 ticket', async () => {
  const { createHash } = await import('node:crypto');
  const number = 'TT-' + 'a'.repeat(20);
  const draft = {
    detail: { invoice_number: number, currency_code: 'USD' },
    invoicer: { email_address: 'seller@business.example.com' },
    configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
    primary_recipients: [{billing_info: {email_address:'buyer@personal.example.com'}}],
    items: [{name:'Demo Item',quantity:'1',unit_amount:{currency_code:'USD',value:'109.00'}}],
  };
  const ticket = {
    status: 'UNCERTAIN',
    paypalRequestId:'12345678-1234-4123-8123-123456789abc',
    requestBodySha256:createHash('sha256').update(JSON.stringify(draft)).digest('hex'),
    invoiceNumber:number, expectedTotal:{currency_code:'USD',value:'109.00'}, draftBody:draft,
  };
  const seen=[];
  const fake = async (url,init) => {
    const path = new URL(url).pathname; seen.push(path);
    assert.equal(new URL(url).origin,'https://api-m.sandbox.paypal.com');
    assert.equal(init.redirect,'error');
    if (path==='/v1/oauth2/token') {
      assert.equal(init.method,'POST');
      return new Response(JSON.stringify({token_type:'Bearer',access_token:'test',scope:'https://uri.paypal.com/services/invoicing/invoices/readwrite'}),{status:200});
    }
    if (path==='/v2/invoicing/invoices') {
      assert.equal(init.method,'POST');
      assert.equal(new Headers(init.headers).get('Prefer'),'return=representation');
      assert.equal(new Headers(init.headers).get('PayPal-Request-Id'),ticket.paypalRequestId);
      assert.equal(init.body, JSON.stringify(draft));
      return new Response(JSON.stringify({id:'INV2-TRADETRUST-TEST-0001'}),{status:201});
    }
    assert.equal(path, '/v2/invoicing/invoices/INV2-TRADETRUST-TEST-0001');
    assert.equal(init.method,'GET');
    return new Response(JSON.stringify({id:'INV2-TRADETRUST-TEST-0001',status:'DRAFT',
      detail:draft.detail, amount:{currency_code:'USD',value:'109.00'},
      invoicer:draft.invoicer,primary_recipients:draft.primary_recipients,items:draft.items}),{status:200});
  };
  const result=await createSandboxDraftRealSandboxOnce({ ...full,
    PAYPAL_CLIENT_ID:'test-id', PAYPAL_CLIENT_SECRET:'test-secret',
    PAYPAL_SANDBOX_MERCHANT_EMAIL:'seller@business.example.com',
  },ticket,fake);
  assert.equal(result.totalValue,'109.00');
  assert.equal(result.status,'DRAFT');
  assert.deepEqual(seen,['/v1/oauth2/token','/v2/invoicing/invoices','/v2/invoicing/invoices/INV2-TRADETRUST-TEST-0001']);
});

test('real transport is not registered with the application router', () => {
  const router = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(router, /real-sandbox-draft-local|executeOneRealSandboxDraftLocal|createSandboxDraftRealSandboxOnce/);
});
