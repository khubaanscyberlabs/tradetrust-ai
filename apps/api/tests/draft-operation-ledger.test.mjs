import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { claimPreparedDraft, finalizeVerifiedDraft } from '../src/paypal/draft-operation-ledger.ts';

const BIND = Object.freeze({ merchantId: 'merchant-A', approvalId: 'approval-A' });
const OP_ID = '11111111-1111-4111-8111-111111111111';
const REQ_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NUMBER = 'TT-1234567890abcdef1234';
const INV = 'INV2-TEST-1234-5678-ABCD';

async function fixture(options = {}) {
  const body = {
    detail: { invoice_number: NUMBER, currency_code: 'USD' },
    invoicer: { email_address: 'seller@example.test' },
    primary_recipients: [{ billing_info: { email_address: 'buyer@example.test' } }],
    items: [{ name: 'Outfit', quantity: '1', unit_amount: { currency_code: 'USD', value: '109.00' } }],
    configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
  };
  const digestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
  const digest = [...new Uint8Array(digestBytes)].map(x => x.toString(16).padStart(2, '0')).join('');
  const database = new DatabaseSync(':memory:');
  database.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE approvals(id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, merchant_id TEXT NOT NULL,
      revision_no INTEGER NOT NULL, snapshot_sha256 TEXT NOT NULL);
    CREATE TABLE quote_revisions(quote_id TEXT NOT NULL, merchant_id TEXT NOT NULL,
      revision_no INTEGER NOT NULL, snapshot_sha256 TEXT NOT NULL, total_cents INTEGER NOT NULL,
      UNIQUE (quote_id,merchant_id,revision_no,snapshot_sha256));
    INSERT INTO quote_revisions VALUES ('quote-A','merchant-A',1,'${'a'.repeat(64)}',10900);
    INSERT INTO approvals VALUES ('approval-A','quote-A','merchant-A',1,'${'a'.repeat(64)}');`);
  database.exec(readFileSync(new URL('../migrations/0005_paypal_draft_operations.sql', import.meta.url), 'utf8'));
  database.prepare(`INSERT INTO paypal_draft_operations(
    id,approval_id,merchant_id,quote_id,revision_no,snapshot_sha256,
    request_body_sha256,paypal_request_id,invoice_number,expected_total_cents,currency
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      OP_ID, BIND.approvalId, BIND.merchantId, 'quote-A', 1, 'a'.repeat(64),
      digest, REQ_ID, NUMBER, 10900, 'USD',
    );
  const adapter = {
    prepare(sql) {
      let values = [];
      const stmt = database.prepare(sql);
      return {
        bind(...args) { values = args; return this; },
        async first() { return stmt.get(...values) ?? null; },
        async run() { const result = stmt.run(...values); return {
          success: true, meta: { changes: Number(result.changes) },
        }; },
      };
    },
  };
  const prepared = Object.freeze({
    status: 'PREPARED', operationId: OP_ID, paypalRequestId: REQ_ID,
    invoiceNumber: NUMBER, expectedTotal: { currency_code: 'USD', value: '109.00' },
    draftBody: body, paymentInitiated: false, ...options,
  });
  const verified = Object.freeze({
    status: 'DRAFT', invoiceId: INV, invoiceNumber: NUMBER,
    currencyCode: 'USD', totalValue: '109.00',
  });
  const state = () => database.prepare('SELECT status, paypal_invoice_id FROM paypal_draft_operations').get();
  return { database, adapter, prepared, verified, state };
}

async function rejects(expected, fn) {
  await assert.rejects(fn(), new RegExp(expected));
}

test('atomically claims PREPARED to UNCERTAIN in actual SQLite migration', async () => {
  const f = await fixture();
  const claim = await claimPreparedDraft(f.adapter, BIND, f.prepared);
  assert.equal(claim.ticket.status, 'UNCERTAIN');
  assert.equal(claim.ticket.paypalRequestId, REQ_ID);
  assert.equal(f.state().status, 'UNCERTAIN');
  assert.equal(f.state().paypal_invoice_id, null);
});

test('completes verified DRAFT and persists immutable invoice id', async () => {
  const f = await fixture();
  const c = await claimPreparedDraft(f.adapter, BIND, f.prepared);
  const done = await finalizeVerifiedDraft(f.adapter, BIND, f.prepared, c, f.verified);
  assert.deepEqual(done, { status: 'DRAFT_CREATED', invoiceId: INV, operationId: OP_ID });
  assert.equal(f.state().status, 'DRAFT_CREATED');
  assert.equal(f.state().paypal_invoice_id, INV);
});

test('replaying claim is rejected, never transitions backward', async () => {
  const f = await fixture();
  await claimPreparedDraft(f.adapter, BIND, f.prepared);
  await rejects('PAYPAL_DRAFT_LEDGER_REJECTED', () => claimPreparedDraft(f.adapter, BIND, f.prepared));
  assert.equal(f.state().status, 'UNCERTAIN');
});

test('two concurrent claims permit exactly one winner', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    claimPreparedDraft(f.adapter, BIND, f.prepared),
    claimPreparedDraft(f.adapter, BIND, f.prepared),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(f.state().status, 'UNCERTAIN');
});

test('wrong merchant and approval identifiers fail before mutation', async () => {
  const f = await fixture();
  await rejects('PAYPAL_DRAFT_LEDGER_REJECTED', () => claimPreparedDraft(f.adapter, { ...BIND, merchantId: 'merchant-B' }, f.prepared));
  await rejects('PAYPAL_DRAFT_LEDGER_REJECTED', () => claimPreparedDraft(f.adapter, { ...BIND, approvalId: 'approval-B' }, f.prepared));
  assert.equal(f.state().status, 'PREPARED');
});

test('tampered request body fails sha256 match before DB update', async () => {
  const f = await fixture();
  const body = structuredClone(f.prepared.draftBody);
  body.items[0].unit_amount.value = '1.00';
  await rejects('PAYPAL_DRAFT_LEDGER_REJECTED', () => claimPreparedDraft(f.adapter, BIND, { ...f.prepared, draftBody: body }));
  assert.equal(f.state().status, 'PREPARED');
});

test('forged $1 total cannot claim the $109 operation', async () => {
  const f = await fixture();
  await rejects('PAYPAL_DRAFT_LEDGER_REJECTED', () => claimPreparedDraft(f.adapter, BIND, {
    ...f.prepared, expectedTotal: { currency_code: 'USD', value: '1.00' },
  }));
  assert.equal(f.state().status, 'PREPARED');
});

test('invalid request ID is rejected before UPDATE', async () => {
  const f = await fixture();
  await rejects('PAYPAL_DRAFT_LEDGER_REJECTED', () => claimPreparedDraft(f.adapter, BIND, { ...f.prepared, paypalRequestId: 'new-id' }));
  assert.equal(f.state().status, 'PREPARED');
});

test('no approval at claim time blocks CAS even after preparation', async () => {
  const f = await fixture();
  f.database.exec('PRAGMA foreign_keys = OFF');
  f.database.prepare('DELETE FROM approvals').run();
  await rejects('PAYPAL_DRAFT_RECONCILIATION_REQUIRED', () => claimPreparedDraft(f.adapter, BIND, f.prepared));
  assert.equal(f.state().status, 'PREPARED');
});

test('no quote revision at claim time blocks CAS', async () => {
  const f = await fixture();
  f.database.exec('PRAGMA foreign_keys = OFF');
  f.database.prepare('DELETE FROM quote_revisions').run();
  await rejects('PAYPAL_DRAFT_RECONCILIATION_REQUIRED', () => claimPreparedDraft(f.adapter, BIND, f.prepared));
  assert.equal(f.state().status, 'PREPARED');
});

test('incorrect verified invoice status/amount/id cannot finalize', async () => {
  const f = await fixture();
  const c = await claimPreparedDraft(f.adapter, BIND, f.prepared);
  for (const change of [
    { status: 'SENT' }, { totalValue: '1.00' }, { invoiceId: 'WRONG' },
    { currencyCode: 'EUR' }, { invoiceNumber: 'TT-123' },
  ]) {
    await rejects('PAYPAL_DRAFT_LEDGER_REJECTED', () => finalizeVerifiedDraft(
      f.adapter, BIND, f.prepared, c, { ...f.verified, ...change },
    ));
  }
  assert.equal(f.state().status, 'UNCERTAIN');
});

test('finalization replay is denied; first invoice unchanged', async () => {
  const f = await fixture();
  const c = await claimPreparedDraft(f.adapter, BIND, f.prepared);
  await finalizeVerifiedDraft(f.adapter, BIND, f.prepared, c, f.verified);
  await rejects('PAYPAL_DRAFT_RECONCILIATION_REQUIRED', () => finalizeVerifiedDraft(f.adapter, BIND, f.prepared, c, f.verified));
  assert.equal(f.state().paypal_invoice_id, INV);
});

test('claim D1 update failure never gives out a ticket', async () => {
  const f = await fixture();
  const broken = { prepare(sql) {
    const st = f.adapter.prepare(sql);
    if (sql.includes("SET status = 'UNCERTAIN'")) st.run = async () => { throw Error('db failed SECRET'); };
    return st;
  } };
  await rejects('PAYPAL_DRAFT_RECONCILIATION_REQUIRED', () => claimPreparedDraft(broken, BIND, f.prepared));
  assert.equal(f.state().status, 'PREPARED');
});

test('final D1 update failure stays UNCERTAIN for reconciliation', async () => {
  const f = await fixture();
  const c = await claimPreparedDraft(f.adapter, BIND, f.prepared);
  const broken = { prepare(sql) {
    const st = f.adapter.prepare(sql);
    if (sql.includes("SET status = 'DRAFT_CREATED'")) st.run = async () => { throw Error('db failed SECRET'); };
    return st;
  } };
  await rejects('PAYPAL_DRAFT_RECONCILIATION_REQUIRED', () => finalizeVerifiedDraft(broken, BIND, f.prepared, c, f.verified));
  assert.equal(f.state().status, 'UNCERTAIN');
});

test('no HTTP fetch or public route in ledger source', () => {
  const source = readFileSync(new URL('../src/paypal/draft-operation-ledger.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\btransport\s*\(/);
  assert.doesNotMatch(source, /new Request\(/);
  assert.doesNotMatch(source, /PAYPAL_CLIENT_SECRET/);
});
