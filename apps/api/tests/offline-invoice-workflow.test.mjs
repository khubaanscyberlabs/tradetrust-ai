import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { executePreparedDraftOffline, simulateApprovedDraftOffline } from '../src/paypal/offline-invoice-workflow.ts';

const OP = '11111111-1111-4111-8111-111111111111';
const REQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NUM = 'TT-1234567890abcdef1234';
const BIND = Object.freeze({ merchantId: 'merchant-A', approvalId: 'approval-A' });
const ENV = Object.freeze({
  PAYPAL_ENVIRONMENT: 'SANDBOX', PAYPAL_DRAFT_CREATE_MODE: 'MOCK_ONLY',
  PAYPAL_CLIENT_ID: 'local-fixture-id', PAYPAL_CLIENT_SECRET: 'test-only-not-a-real-secret',
  PAYPAL_SANDBOX_MERCHANT_EMAIL: 'seller@example.test',
  TRADETRUST_OFFLINE_SIMULATION: 'ENABLED_LOCAL_ONLY',
  TRADETRUST_MOCK_MERCHANT_ID: 'merchant-A',
  TRADETRUST_MOCK_BUYER_EMAIL: 'buyer@example.test',
  TRADETRUST_MOCK_MERCHANT_NAME: 'Synthetic Seller',
});

async function fixture() {
  const draftBody = {
    detail: { currency_code:'USD', invoice_number:NUM, payment_term:{term_type:'DUE_ON_RECEIPT'} },
    invoicer: { email_address:'seller@example.test', business_name:'Synthetic Seller' },
    primary_recipients: [{ billing_info:{ email_address:'buyer@example.test' } }],
    items: [{ name:'TradeTrust Outfit', quantity:'1', unit_amount:{currency_code:'USD',value:'109.00'} }],
    configuration: {allow_tip:false, partial_payment:{allow_partial_payment:false}},
  };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(draftBody)));
  const digest = [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2,'0')).join('');
  const raw = new DatabaseSync(':memory:');
  raw.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE approvals(id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, merchant_id TEXT NOT NULL,
      revision_no INTEGER NOT NULL, snapshot_sha256 TEXT NOT NULL);
    CREATE TABLE quote_revisions(quote_id TEXT NOT NULL, merchant_id TEXT NOT NULL,
      revision_no INTEGER NOT NULL, snapshot_sha256 TEXT NOT NULL, total_cents INTEGER NOT NULL,
      UNIQUE (quote_id,merchant_id,revision_no,snapshot_sha256));
    INSERT INTO quote_revisions VALUES ('quote-A','merchant-A',1,'${'a'.repeat(64)}',10900);
    INSERT INTO approvals VALUES ('approval-A','quote-A','merchant-A',1,'${'a'.repeat(64)}');`);
  raw.exec(readFileSync(new URL('../migrations/0005_paypal_draft_operations.sql', import.meta.url),'utf8'));
  raw.prepare(`INSERT INTO paypal_draft_operations(id,approval_id,merchant_id,quote_id,revision_no,
    snapshot_sha256,request_body_sha256,paypal_request_id,invoice_number,expected_total_cents,currency)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      OP,BIND.approvalId,BIND.merchantId,'quote-A',1,'a'.repeat(64),digest,REQ,NUM,10900,'USD',
    );
  const db = {
    prepare(sql) {
      const statement=raw.prepare(sql);
      let params=[];
      return {
        bind(...values){params=values;return this;},
        async first(){return statement.get(...params) ?? null;},
        async run(){const result=statement.run(...params);return {success:true,meta:{changes:Number(result.changes)}};},
      };
    },
  };
  const prepared=Object.freeze({
    status:'PREPARED',operationId:OP,paypalRequestId:REQ,invoiceNumber:NUM,
    expectedTotal:{currency_code:'USD',value:'109.00'},draftBody,paymentInitiated:false,
  });
  const state=()=>raw.prepare('SELECT status,paypal_invoice_id FROM paypal_draft_operations').get();
  return { db,raw,prepared,state,env:{...ENV,DB:db} };
}
async function blocked(code, fn){await assert.rejects(fn(),new RegExp(code));}

test('offline complete flow: one synthetic invoice, exact $109 and D1 final', async()=>{
  const f=await fixture();
  const got=await executePreparedDraftOffline(f.db,BIND,f.prepared,f.env);
  assert.deepEqual(got,{status:'DRAFT_CREATED',invoiceId:'INV2-TRADETRUST-LOCAL-MOCK-0001',operationId:OP});
  assert.equal(f.state().status,'DRAFT_CREATED');
  assert.equal(f.state().paypal_invoice_id,got.invoiceId);
});

test('offline create timeout stays UNCERTAIN; never retries',async()=>{
  const f=await fixture();
  await blocked('PAYPAL_DRAFT_RECONCILIATION_REQUIRED',()=>executePreparedDraftOffline(
    f.db,BIND,f.prepared,f.env,'CREATE_TIMEOUT'));
  assert.equal(f.state().status,'UNCERTAIN');
  await blocked('PAYPAL_DRAFT_LEDGER_REJECTED',()=>executePreparedDraftOffline(f.db,BIND,f.prepared,f.env));
  assert.equal(f.state().status,'UNCERTAIN');
});

test('provider wrong amount fails and stays UNCERTAIN',async()=>{
  const f=await fixture();
  await blocked('PAYPAL_DRAFT_RECONCILIATION_REQUIRED',()=>executePreparedDraftOffline(
    f.db,BIND,f.prepared,f.env,'GET_WRONG_AMOUNT'));
  assert.equal(f.state().status,'UNCERTAIN');
});

test('offline mode disabled before D1 mutation',async()=>{
  const f=await fixture();
  await blocked('TRADETRUST_OFFLINE_WORKFLOW_DENIED',()=>executePreparedDraftOffline(
    f.db,BIND,f.prepared,{...f.env,TRADETRUST_OFFLINE_SIMULATION:undefined}));
  assert.equal(f.state().status,'PREPARED');
});

test('LIVE mode denied before D1 mutation',async()=>{
  const f=await fixture();
  await blocked('TRADETRUST_OFFLINE_WORKFLOW_DENIED',()=>executePreparedDraftOffline(
    f.db,BIND,f.prepared,{...f.env,PAYPAL_ENVIRONMENT:'LIVE'}));
  assert.equal(f.state().status,'PREPARED');
});

test('real transport mode denied before D1 mutation',async()=>{
  const f=await fixture();
  await blocked('TRADETRUST_OFFLINE_WORKFLOW_DENIED',()=>executePreparedDraftOffline(
    f.db,BIND,f.prepared,{...f.env,PAYPAL_DRAFT_CREATE_MODE:'REAL'}));
  assert.equal(f.state().status,'PREPARED');
});

test('incorrect trusted merchant bound to operation denied',async()=>{
  const f=await fixture();
  await blocked('TRADETRUST_OFFLINE_WORKFLOW_DENIED',()=>executePreparedDraftOffline(
    f.db,BIND,f.prepared,{...f.env,TRADETRUST_MOCK_MERCHANT_ID:'merchant-B'}));
  assert.equal(f.state().status,'PREPARED');
});

test('sender and buyer identical denied before claim',async()=>{
  const f=await fixture();
  await blocked('TRADETRUST_OFFLINE_WORKFLOW_DENIED',()=>executePreparedDraftOffline(
    f.db,BIND,f.prepared,{...f.env,TRADETRUST_MOCK_BUYER_EMAIL:'SELLER@example.test'}));
  assert.equal(f.state().status,'PREPARED');
});

test('invalid scenario denied before claim',async()=>{
  const f=await fixture();
  await blocked('TRADETRUST_OFFLINE_WORKFLOW_DENIED',()=>executePreparedDraftOffline(
    f.db,BIND,f.prepared,f.env,'SEND_INVOICE'));
  assert.equal(f.state().status,'PREPARED');
});

test('tampered invoice payload cannot reach synthetic provider',async()=>{
  const f=await fixture();
  const changed=structuredClone(f.prepared);
  changed.draftBody.items[0].unit_amount.value='1.00';
  await blocked('PAYPAL_DRAFT_LEDGER_REJECTED',()=>executePreparedDraftOffline(
    f.db,BIND,changed,f.env));
  assert.equal(f.state().status,'PREPARED');
});

test('signed-human wrapper refuses invalid mock configuration before identity or writes',async()=>{
  const f=await fixture();
  await blocked('TRADETRUST_OFFLINE_WORKFLOW_DENIED',()=>simulateApprovedDraftOffline(
    new Request('http://localhost/'), {...f.env, PAYPAL_DRAFT_CREATE_MODE:undefined}, BIND));
  assert.equal(f.state().status,'PREPARED');
});

test('second execution of a completed operation is rejected',async()=>{
  const f=await fixture();
  await executePreparedDraftOffline(f.db,BIND,f.prepared,f.env);
  await blocked('PAYPAL_DRAFT_LEDGER_REJECTED',()=>executePreparedDraftOffline(f.db,BIND,f.prepared,f.env));
  assert.equal(f.state().status,'DRAFT_CREATED');
});

test('source never invokes global fetch or registers a public route',()=>{
  const src=readFileSync(new URL('../src/paypal/offline-invoice-workflow.ts',import.meta.url),'utf8');
  assert.ok(src.includes('prepareApprovedDraft(request, env'));
  assert.ok(src.includes('claimPreparedDraft('));
  assert.ok(src.includes('finalizeVerifiedDraft('));
  assert.ok(!/\bawait\s+fetch\s*\(|\bglobalThis\.fetch\s*\(/.test(src));
  assert.ok(!src.includes('addEventListener('));
});
