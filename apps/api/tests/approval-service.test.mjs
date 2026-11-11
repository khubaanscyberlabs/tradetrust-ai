import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
} from 'jose';

import {
  approveQuote,
} from '../src/approval-service.ts';

const TEAM = 'https://demo.cloudflareaccess.com';
const AUD = 'a'.repeat(64);

const KEY =
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const input = () => ({
  merchantId: 'merchant-A',
  quoteId: 'quote-A',
  revision: 1,
  snapshotSha256: 'a'.repeat(64),
  idempotencyKey: KEY,
});

const keys = (async () => {
  const pair = await generateKeyPair(
    'RS256',
    { extractable: true },
  );

  const jwk = await exportJWK(pair.publicKey);

  return {
    privateKey: pair.privateKey,
    resolver: createLocalJWKSet({
      keys: [{
        ...jwk,
        kid: 'approval-test-key',
        alg: 'RS256',
        use: 'sig',
      }],
    }),
  };
})();

async function request(subject = 'human-owner') {
  const headers = {};

  if (subject !== null) {
    const { privateKey } = await keys;
    const now = Math.floor(Date.now() / 1000);

    const jwt = await new SignJWT({
      iss: TEAM,
      aud: [AUD],
      sub: subject,
      type: 'app',
      email: 'synthetic@example.test',
      iat: now,
      nbf: now - 5,
      exp: now + 1800,
    })
      .setProtectedHeader({
        alg: 'RS256',
        kid: 'approval-test-key',
      })
      .sign(privateKey);

    headers['Cf-Access-Jwt-Assertion'] = jwt;
  }

  return new Request(
    'http://127.0.0.1:8787/internal-test',
    { headers },
  );
}

function setup(failAudit = false) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');

  for (const name of [
    '0001_dealroom_foundation.sql',
    '0002_approval_integrity.sql',
    '0003_merchant_authorization.sql',
    '0004_approval_idempotency.sql',
  ]) {
    raw.exec(readFileSync(
      new URL(`../migrations/${name}`, import.meta.url),
      'utf8',
    ));
  }

  raw.prepare(
    'INSERT INTO merchants(id,display_name) VALUES(?,?)',
  ).run('merchant-A', 'Synthetic A');

  raw.prepare(
    'INSERT INTO dealrooms(id,merchant_id) VALUES(?,?)',
  ).run('room-A', 'merchant-A');

  raw.prepare(
    'INSERT INTO quotes(id,merchant_id,dealroom_id) VALUES(?,?,?)',
  ).run('quote-A', 'merchant-A', 'room-A');

  raw.prepare(`
    INSERT INTO quote_revisions (
      quote_id,merchant_id,revision_no,currency,
      subtotal_cents,discount_cents,shipping_cents,
      total_cents,snapshot_json,snapshot_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    'quote-A', 'merchant-A', 1, 'USD',
    8400, 0, 2500, 10900, '{}', 'a'.repeat(64),
  );

  for (const [actor, subject, role] of [
    ['actor-owner', 'human-owner', 'OWNER'],
    ['actor-staff', 'human-staff', 'STAFF'],
  ]) {
    raw.prepare(`
      INSERT INTO merchant_actors(
        id,provider,issuer,subject
      ) VALUES (?,?,?,?)
    `).run(
      actor, 'CLOUDFLARE_ACCESS', TEAM, subject,
    );

    raw.prepare(`
      INSERT INTO merchant_memberships(
        merchant_id,actor_id,role
      ) VALUES (?,?,?)
    `).run('merchant-A', actor, role);
  }

  // D1-shaped test adapter backed by real SQLite.
  const prepare = (sql, values = []) => ({
    bind(...next) {
      return prepare(sql, next);
    },
    async first() {
      return raw.prepare(sql).get(...values) ?? null;
    },
    run() {
      if (
        failAudit &&
        sql.includes('INSERT INTO audit_events')
      ) {
        throw Error('synthetic audit interruption');
      }

      return raw.prepare(sql).run(...values);
    },
  });

  const DB = {
    prepare,
    async batch(statements) {
      raw.exec('BEGIN IMMEDIATE');

      try {
        const results = [];

        for (const statement of statements) {
          statement.run();
          results.push({ success: true });
        }

        raw.exec('COMMIT');
        return results;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };

  const counts = () => [
    'approvals',
    'approval_idempotency',
    'audit_events',
  ].map(table =>
    raw.prepare(
      `SELECT COUNT(*) AS n FROM ${table}`,
    ).get().n
  );

  const environment = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    DB,
  };

  return { raw, environment, counts };
}

async function execute(
  environment,
  body = input(),
  subject = 'human-owner',
) {
  const { resolver } = await keys;

  return approveQuote(
    await request(subject),
    environment,
    body,
    resolver,
  );
}

test('commits approval, ledger and audit', async () => {
  const { environment, counts } = setup();

  const result = await execute(environment);

  assert.equal(result.replayed, false);
  assert.equal(result.paymentInitiated, false);
  assert.deepEqual(counts(), [1, 1, 1]);
});

test('replays identical request without writes', async () => {
  const { environment, counts } = setup();

  const first = await execute(environment);
  const retry = await execute(environment);

  assert.equal(retry.replayed, true);
  assert.equal(retry.approvalId, first.approvalId);
  assert.deepEqual(counts(), [1, 1, 1]);
});

test('rejects same key with changed snapshot', async () => {
  const { environment, counts } = setup();

  await execute(environment);

  await assert.rejects(
    execute(environment, {
      ...input(),
      snapshotSha256: 'b'.repeat(64),
    }),
    /APPROVAL_IDEMPOTENCY_CONFLICT/,
  );

  assert.deepEqual(counts(), [1, 1, 1]);
});

test('blocks second key for same quote', async () => {
  const { environment, counts } = setup();

  await execute(environment);

  await assert.rejects(
    execute(environment, {
      ...input(),
      idempotencyKey:
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
    /APPROVAL_NOT_COMMITTED/,
  );

  assert.deepEqual(counts(), [1, 1, 1]);
});

test('rejects invalid or missing human', async () => {
  const { environment, counts } = setup();

  await assert.rejects(
    execute(environment, input(), null),
    /MERCHANT_AUTHORIZATION_DENIED/,
  );

  assert.deepEqual(counts(), [0, 0, 0]);
});

test('denies staff approval', async () => {
  const { environment, counts } = setup();

  await assert.rejects(
    execute(environment, input(), 'human-staff'),
    /MERCHANT_AUTHORIZATION_DENIED/,
  );

  assert.deepEqual(counts(), [0, 0, 0]);
});

test('rejects stale or incorrect quote hash', async () => {
  const { environment, counts } = setup();

  await assert.rejects(
    execute(environment, {
      ...input(),
      snapshotSha256: 'b'.repeat(64),
    }),
    /APPROVAL_STALE_OR_NOT_FOUND/,
  );

  assert.deepEqual(counts(), [0, 0, 0]);
});

test('rejects malformed idempotency keys', async () => {
  const { environment, counts } = setup();

  await assert.rejects(
    execute(environment, {
      ...input(),
      idempotencyKey: 'invalid-key',
    }),
    /APPROVAL_REQUEST_INVALID/,
  );

  assert.deepEqual(counts(), [0, 0, 0]);
});

test('rejects financial-field injection', async () => {
  const { environment, counts } = setup();

  await assert.rejects(
    execute(environment, {
      ...input(),
      totalCents: 1,
    }),
    /APPROVAL_REQUEST_INVALID/,
  );

  assert.deepEqual(counts(), [0, 0, 0]);
});

test('rolls back approval when audit fails', async () => {
  const { environment, counts } = setup(true);

  await assert.rejects(
    execute(environment),
    /APPROVAL_NOT_COMMITTED/,
  );

  assert.deepEqual(counts(), [0, 0, 0]);
});

test('handles concurrent duplicate requests', async () => {
  const { environment, counts } = setup();

  const results = await Promise.all([
    execute(environment),
    execute(environment),
  ]);

  assert.equal(
    results[0].approvalId,
    results[1].approvalId,
  );

  assert.equal(
    results.filter(x => !x.replayed).length,
    1,
  );

  assert.deepEqual(counts(), [1, 1, 1]);
});

test('denies actor revoked before transaction', async () => {
  const { raw, environment, counts } = setup();

  const originalBatch = environment.DB.batch;

  environment.DB.batch = async statements => {
    raw.prepare(
      `UPDATE merchant_memberships
       SET status='REVOKED'
       WHERE actor_id='actor-owner'`,
    ).run();

    return originalBatch(statements);
  };

  await assert.rejects(
    execute(environment),
    /APPROVAL_NOT_COMMITTED/,
  );

  assert.deepEqual(counts(), [0, 0, 0]);
});
