import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  generateKeyPair, exportJWK, createLocalJWKSet, SignJWT,
} from 'jose';
import { proposeQuote } from '../src/domain/quote.ts';
import { prepareApprovedDraft } from '../src/paypal/prepare-draft.ts';

const TEAM = 'https://demo.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const keys = (async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  return {
    privateKey: pair.privateKey,
    resolver: createLocalJWKSet({ keys: [{
      ...jwk, kid: 'draft-preparation-test', use: 'sig', alg: 'RS256',
    }] }),
  };
})();

function input(overrides = {}) {
  return {
    merchantId: 'merchant-A',
    approvalId: 'approval-A',
    invoicerEmail: 'seller@example.test',
    invoicerBusinessName: 'Synthetic Merchant',
    buyerEmail: 'buyer@example.test',
    ...overrides,
  };
}

function setup({ tampered = false, withApproval = true } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for (const name of [
    '0001_dealroom_foundation.sql',
    '0002_approval_integrity.sql',
    '0003_merchant_authorization.sql',
    '0004_approval_idempotency.sql',
    '0005_paypal_draft_operations.sql',
  ]) {
    raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const quote = proposeQuote({
    items: [{ sku: 'OUTFIT-01', quantity: 2 }], shipping: 'standard',
  });
  const snapshot = JSON.stringify(quote);
  const hash = createHash('sha256').update(snapshot).digest('hex');

  raw.prepare('INSERT INTO merchants(id,display_name) VALUES(?,?)')
    .run('merchant-A', 'Synthetic Merchant');
  raw.prepare('INSERT INTO merchants(id,display_name) VALUES(?,?)')
    .run('merchant-B', 'Other Merchant');
  raw.prepare('INSERT INTO dealrooms(id,merchant_id) VALUES(?,?)')
    .run('room-A', 'merchant-A');
  raw.prepare('INSERT INTO quotes(id,merchant_id,dealroom_id) VALUES(?,?,?)')
    .run('quote-A', 'merchant-A', 'room-A');
  raw.prepare(`INSERT INTO quote_revisions(
    quote_id,merchant_id,revision_no,currency,
    subtotal_cents,discount_cents,shipping_cents,total_cents,
    snapshot_json,snapshot_sha256
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    'quote-A', 'merchant-A', 1, 'USD',
    8400, 0, 2500, 10900,
    tampered ? snapshot.replace('10900', '100') : snapshot, hash,
  );
  for (const [id, subject, role] of [
    ['actor-owner', 'human-owner', 'OWNER'],
    ['actor-staff', 'human-staff', 'STAFF'],
  ]) {
    raw.prepare(`INSERT INTO merchant_actors(id,provider,issuer,subject)
      VALUES(?,?,?,?)`).run(id, 'CLOUDFLARE_ACCESS', TEAM, subject);
    raw.prepare(`INSERT INTO merchant_memberships(merchant_id,actor_id,role)
      VALUES(?,?,?)`).run('merchant-A', id, role);
  }
  if (withApproval) {
    raw.prepare(`INSERT INTO approvals(
      id,quote_id,merchant_id,revision_no,snapshot_sha256,approved_by
    ) VALUES(?,?,?,?,?,?)`).run(
      'approval-A', 'quote-A', 'merchant-A', 1, hash, 'actor-owner',
    );
  }
  const prepare = (sql, values = []) => ({
    bind(...next) { return prepare(sql, next); },
    async first() { return raw.prepare(sql).get(...values) ?? null; },
    async run() {
      raw.prepare(sql).run(...values);
      return { success: true };
    },
  });
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, DB: { prepare } };
  const operationCount = () => raw.prepare(
    'SELECT COUNT(*) AS n FROM paypal_draft_operations',
  ).get().n;
  return { raw, env, operationCount };
}

async function request(subject = 'human-owner') {
  if (subject === null) return new Request('http://127.0.0.1/internal-test');
  const { privateKey } = await keys;
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    iss: TEAM, aud: [AUD], sub: subject, type: 'app',
    email: 'synthetic@example.test',
    iat: now, nbf: now - 5, exp: now + 1800,
  }).setProtectedHeader({ alg: 'RS256', kid: 'draft-preparation-test' })
    .sign(privateKey);
  return new Request('http://127.0.0.1/internal-test', {
    headers: { 'Cf-Access-Jwt-Assertion': jwt },
  });
}

async function run(env, params = input(), subject = 'human-owner') {
  const { resolver } = await keys;
  return prepareApprovedDraft(await request(subject), env, params, resolver);
}

test('prepares one approved $109 operation without external POST', async () => {
  const { env, operationCount, raw } = setup();
  const result = await run(env);
  assert.equal(result.status, 'PREPARED');
  assert.equal(result.replayed, false);
  assert.equal(result.expectedTotal.value, '109.00');
  assert.equal(result.paymentInitiated, false);
  assert.match(result.paypalRequestId, /^[a-f0-9-]{36}$/);
  assert.equal(operationCount(), 1);
  const row = raw.prepare('SELECT expected_total_cents,status,paypal_invoice_id FROM paypal_draft_operations').get();
  assert.deepEqual([row.expected_total_cents,row.status,row.paypal_invoice_id], [10900,'PREPARED',null]);
});

test('identical retry retains stable request and operation IDs', async () => {
  const { env, operationCount } = setup();
  const first = await run(env);
  const second = await run(env);
  assert.equal(second.replayed, true);
  assert.equal(second.operationId, first.operationId);
  assert.equal(second.paypalRequestId, first.paypalRequestId);
  assert.equal(operationCount(), 1);
});

test('concurrent duplicate preparation stores one operation', async () => {
  const { env, operationCount } = setup();
  const [a, b] = await Promise.all([run(env), run(env)]);
  assert.equal(a.operationId, b.operationId);
  assert.equal(a.paypalRequestId, b.paypalRequestId);
  assert.equal([a, b].filter(x => x.replayed === false).length, 1);
  assert.equal(operationCount(), 1);
});

test('changed buyer email conflicts with prepared operation', async () => {
  const { env, operationCount } = setup();
  await run(env);
  await assert.rejects(run(env, input({ buyerEmail: 'other@example.test' })),
    /PAYPAL_DRAFT_OPERATION_CONFLICT/);
  assert.equal(operationCount(), 1);
});

test('missing persisted approval prevents preparation', async () => {
  const { env, operationCount } = setup({ withApproval: false });
  await assert.rejects(run(env), /PAYPAL_APPROVAL_NOT_FOUND/);
  assert.equal(operationCount(), 0);
});

test('cross-tenant caller is rejected', async () => {
  const { env, operationCount } = setup();
  await assert.rejects(run(env, input({ merchantId: 'merchant-B' })),
    /MERCHANT_AUTHORIZATION_DENIED/);
  assert.equal(operationCount(), 0);
});

test('staff user cannot prepare a draft', async () => {
  const { env, operationCount } = setup();
  await assert.rejects(run(env, input(), 'human-staff'),
    /MERCHANT_AUTHORIZATION_DENIED/);
  assert.equal(operationCount(), 0);
});

test('missing identity cannot prepare draft', async () => {
  const { env, operationCount } = setup();
  await assert.rejects(run(env, input(), null),
    /MERCHANT_AUTHORIZATION_DENIED/);
  assert.equal(operationCount(), 0);
});

test('revoked owner cannot prepare a draft', async () => {
  const { raw, env, operationCount } = setup();
  raw.prepare("UPDATE merchant_actors SET status='REVOKED' WHERE id='actor-owner'").run();
  await assert.rejects(run(env), /MERCHANT_AUTHORIZATION_DENIED/);
  assert.equal(operationCount(), 0);
});

test('tampered persisted JSON is denied before operation insertion', async () => {
  const { env, operationCount } = setup({ tampered: true });
  await assert.rejects(run(env), /PAYPAL_INVOICE_MAPPING_REJECTED/);
  assert.equal(operationCount(), 0);
});

test('extra client-controlled total is rejected', async () => {
  const { env, operationCount } = setup();
  await assert.rejects(run(env, input({ totalCents: 1 })),
    /PAYPAL_DRAFT_PREPARATION_INVALID/);
  assert.equal(operationCount(), 0);
});

test('UNCERTAIN requires reconciliation, never a new operation', async () => {
  const { raw, env, operationCount } = setup();
  await run(env);
  raw.prepare("UPDATE paypal_draft_operations SET status='UNCERTAIN'").run();
  await assert.rejects(run(env), /PAYPAL_DRAFT_RECONCILIATION_REQUIRED/);
  assert.equal(operationCount(), 1);
});

test('DRAFT_CREATED cannot be recreated', async () => {
  const { raw, env, operationCount } = setup();
  await run(env);
  raw.prepare("UPDATE paypal_draft_operations SET status='UNCERTAIN'").run();
  raw.prepare("UPDATE paypal_draft_operations SET status='DRAFT_CREATED',paypal_invoice_id='INV2-SYNTHETIC'").run();
  await assert.rejects(run(env), /PAYPAL_DRAFT_ALREADY_CREATED/);
  assert.equal(operationCount(), 1);
});

test('missing D1 fails closed', async () => {
  const { env } = setup();
  await assert.rejects(run({ ...env, DB: undefined }),
    /PAYPAL_DRAFT_UNAVAILABLE/);
});
