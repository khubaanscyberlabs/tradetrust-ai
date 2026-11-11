import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { resolveLocalSandboxParties } from '../src/paypal/trusted-sandbox-parties-local.ts';

// Synthetic in-memory SQLite only. No PayPal, network, or local project D1 writes.
const merchantId = 'merchant-local-demo';
const approvalId = 'approval-synthetic-1';
const sha = 'a'.repeat(64);

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE merchant_actors (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE merchant_memberships (
      actor_id TEXT, merchant_id TEXT, status TEXT, role TEXT
    );
    CREATE TABLE approvals (
      id TEXT, merchant_id TEXT, quote_id TEXT,
      revision_no INTEGER, snapshot_sha256 TEXT
    );
    CREATE TABLE quote_revisions (
      merchant_id TEXT, quote_id TEXT, revision_no INTEGER, snapshot_sha256 TEXT
    );
    CREATE TABLE sandbox_invoice_parties (
      approval_id TEXT, merchant_id TEXT, quote_id TEXT,
      revision_no INTEGER, snapshot_sha256 TEXT,
      invoicer_email TEXT, invoicer_business_name TEXT,
      buyer_email TEXT, origin TEXT
    );
  `);
  const actors = [
    ['actor-access-owner', 'CLOUDFLARE_ACCESS', 'ACTIVE', 'OWNER', 'ACTIVE'],
    ['actor-local-owner', 'LOCAL_SESSION', 'ACTIVE', 'OWNER', 'ACTIVE'],
    ['actor-local-manager', 'LOCAL_SESSION', 'ACTIVE', 'MANAGER', 'ACTIVE'],
    ['actor-local-staff', 'LOCAL_SESSION', 'ACTIVE', 'STAFF', 'ACTIVE'],
    ['actor-local-revoked', 'LOCAL_SESSION', 'REVOKED', 'OWNER', 'ACTIVE'],
    ['actor-local-unmembered', 'LOCAL_SESSION', 'ACTIVE', 'OWNER', 'REVOKED'],
  ];
  for (const [id, provider, actorStatus, role, memberStatus] of actors) {
    sqlite.prepare('INSERT INTO merchant_actors VALUES (?, ?, ?)')
      .run(id, provider, actorStatus);
    sqlite.prepare('INSERT INTO merchant_memberships VALUES (?, ?, ?, ?)')
      .run(id, merchantId, memberStatus, role);
  }
  sqlite.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?, ?)')
    .run(approvalId, merchantId, 'quote-synthetic-1', 1, sha);
  sqlite.prepare('INSERT INTO quote_revisions VALUES (?, ?, ?, ?)')
    .run(merchantId, 'quote-synthetic-1', 1, sha);
  sqlite.prepare('INSERT INTO sandbox_invoice_parties VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(approvalId, merchantId, 'quote-synthetic-1', 1, sha,
      'synthetic-merchant@example.test', 'Synthetic Merchant',
      'synthetic-buyer@example.test', 'LOCAL_OPERATOR_REGISTERED');

  const queryLog = [];
  const db = {
    prepare(sql) {
      queryLog.push(sql);
      return {
        bind(...values) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...values) ?? null;
            },
          };
        },
      };
    },
  };
  return { sqlite, db, queryLog };
}

function merchant(actorId, role, id = merchantId) {
  // Test-only AuthorizedMerchant surrogate. Real callers must authenticate
  // with the application's existing verified identity boundary first.
  return Object.freeze({ actorId, role, merchantId: id });
}

for (const [actor, role, scenario] of [
  ['actor-access-owner', 'OWNER', 'existing Cloudflare Access owner'],
  ['actor-local-owner', 'OWNER', 'authenticated local session owner'],
  ['actor-local-manager', 'MANAGER', 'authenticated local session manager'],
]) {
  test(`${scenario} resolves only the exact synthetic approved parties`, async () => {
    const { sqlite, db, queryLog } = setup();
    try {
      const result = await resolveLocalSandboxParties(
        db, merchant(actor, role), approvalId
      );
      assert.equal(result.approvalId, approvalId);
      assert.equal(result.snapshotSha256, sha);
      assert.equal(result.parties.merchantId, merchantId);
      assert.equal(result.parties.buyerEmail, 'synthetic-buyer@example.test');
      assert.equal(result.sourceAssurance,
        'LOCAL_D1_OPERATOR_REGISTERED_NOT_PROVIDER_VERIFIED');
      assert.equal(result.paypalIdentityVerified, false);
      assert.equal(result.paymentAuthorized, false);
      assert.equal(queryLog.length, 1);
      assert.match(queryLog[0], /ma\.provider IN \('CLOUDFLARE_ACCESS', 'LOCAL_SESSION'\)/);
      assert.match(queryLog[0], /mm\.role IN \('OWNER','MANAGER'\)/);
    } finally {
      sqlite.close();
    }
  });
}

for (const [actor, role, scenario] of [
  ['actor-local-staff', 'STAFF', 'staff'],
  ['actor-local-revoked', 'OWNER', 'revoked actor'],
  ['actor-local-unmembered', 'OWNER', 'revoked membership'],
]) {
  test(`${scenario} cannot retrieve trusted sandbox parties`, async () => {
    const { sqlite, db } = setup();
    try {
      await assert.rejects(
        resolveLocalSandboxParties(db, merchant(actor, role), approvalId),
        /TRUSTED_SANDBOX_PARTY_LOOKUP_REJECTED/
      );
    } finally {
      sqlite.close();
    }
  });
}

test('cross-merchant and wrong approval cannot retrieve parties', async () => {
  const { sqlite, db } = setup();
  try {
    await assert.rejects(
      resolveLocalSandboxParties(db,
        merchant('actor-local-owner', 'OWNER', 'other-merchant'), approvalId),
      /TRUSTED_SANDBOX_PARTY_LOOKUP_REJECTED/
    );
    await assert.rejects(
      resolveLocalSandboxParties(db,
        merchant('actor-local-owner', 'OWNER'), 'approval-not-found'),
      /TRUSTED_SANDBOX_PARTY_LOOKUP_REJECTED/
    );
  } finally {
    sqlite.close();
  }
});

test('superseded quote revision is rejected', async () => {
  const { sqlite, db } = setup();
  try {
    sqlite.prepare('INSERT INTO quote_revisions VALUES (?, ?, ?, ?)')
      .run(merchantId, 'quote-synthetic-1', 2, 'b'.repeat(64));
    await assert.rejects(
      resolveLocalSandboxParties(db,
        merchant('actor-local-owner', 'OWNER'), approvalId),
      /TRUSTED_SANDBOX_PARTY_LOOKUP_REJECTED/
    );
  } finally {
    sqlite.close();
  }
});
