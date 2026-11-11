import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { getPlatformProxy } from 'wrangler';
import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
} from 'jose';

import { approveQuote } from '../src/approval-service.ts';

const state = process.env.TRADETRUST_TEST_STATE;
const expectedRoot = resolve(
  process.env.HOME,
  '.tradetrust-ai-private-test-state',
);

assert.equal(typeof state, 'string');
assert.ok(resolve(state).startsWith(expectedRoot + '/'));
assert.ok(statSync(state).isDirectory());
assert.ok((statSync(state).mode & 0o777) === 0o700);

const TEAM = 'https://demo.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const merchant = 'merchant-08c03-synthetic';
const room = 'room-08c03-synthetic';
const actor = 'actor-08c03-owner';
const quoteId = 'quote-08c03-synthetic';

const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const snapshot = JSON.stringify({
  testOnly: true,
  currency: 'USD',
  subtotalCents: 8400,
  shippingCents: 2500,
  discountCents: 0,
  totalCents: 10900,
});

const hash = createHash('sha256')
  .update(snapshot)
  .digest('hex');

let platform;

try {
  platform = await getPlatformProxy({
    configPath: join(process.cwd(), 'wrangler.jsonc'),
    persist: { path: join(state, 'v3') },
    remoteBindings: false,
  });

  const DB = platform.env.DB;

  assert.ok(DB);
  assert.equal(typeof DB.prepare, 'function');
  assert.equal(typeof DB.batch, 'function');

  const migrations = await DB.prepare(
    'SELECT COUNT(*) AS n FROM d1_migrations',
  ).first();

  assert.equal(migrations.n, 4);
  console.log('WORKER_D1_BINDING=PASS');
  console.log('MIGRATIONS_APPLIED=4_OF_4');

  const before = await DB.prepare(
    'SELECT COUNT(*) AS n FROM approvals',
  ).first();

  assert.equal(before.n, 0);

  const seeded = await DB.batch([
    DB.prepare(
      'INSERT INTO merchants(id,display_name) VALUES(?,?)',
    ).bind(merchant, 'Synthetic Test Merchant'),

    DB.prepare(
      'INSERT INTO dealrooms(id,merchant_id) VALUES(?,?)',
    ).bind(room, merchant),

    DB.prepare(
      'INSERT INTO quotes(id,merchant_id,dealroom_id) VALUES(?,?,?)',
    ).bind(quoteId, merchant, room),

    DB.prepare(`
      INSERT INTO quote_revisions(
        quote_id,merchant_id,revision_no,currency,
        subtotal_cents,discount_cents,shipping_cents,
        total_cents,snapshot_json,snapshot_sha256
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(
      quoteId, merchant, 1, 'USD',
      8400, 0, 2500, 10900, snapshot, hash,
    ),

    DB.prepare(`
      INSERT INTO merchant_actors(
        id,provider,issuer,subject
      ) VALUES(?,?,?,?)
    `).bind(
      actor, 'CLOUDFLARE_ACCESS',
      TEAM, 'human-08c03-synthetic',
    ),

    DB.prepare(`
      INSERT INTO merchant_memberships(
        merchant_id,actor_id,role
      ) VALUES(?,?,?)
    `).bind(merchant, actor, 'OWNER'),
  ]);

  assert.equal(seeded.length, 6);
  assert.ok(seeded.every(x => x.success));

  console.log('SYNTHETIC_FIXTURES=PASS');

  const pair = await generateKeyPair('RS256', {
    extractable: true,
  });

  const jwk = await exportJWK(pair.publicKey);

  const resolver = createLocalJWKSet({
    keys: [{
      ...jwk,
      kid: 'integration-test-key',
      alg: 'RS256',
      use: 'sig',
    }],
  });

  async function humanRequest(subject) {
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
        kid: 'integration-test-key',
      })
      .sign(pair.privateKey);

    return new Request(
      'http://127.0.0.1:8787/internal-test',
      {
        headers: {
          'Cf-Access-Jwt-Assertion': jwt,
        },
      },
    );
  }

  const env = {
    DB,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
  };

  const input = {
    merchantId: merchant,
    quoteId,
    revision: 1,
    snapshotSha256: hash,
    idempotencyKey: key,
  };

  const validRequest =
    await humanRequest('human-08c03-synthetic');

  const unauthorizedRequest =
    await humanRequest('unknown-human-08c03');

  await assert.rejects(
    approveQuote(
      unauthorizedRequest, env, input, resolver,
    ),
    /MERCHANT_AUTHORIZATION_DENIED/,
  );

  console.log('UNAUTHORIZED_HUMAN_DENIED=PASS');

  await assert.rejects(
    approveQuote(
      validRequest,
      env,
      { ...input, snapshotSha256: 'b'.repeat(64) },
      resolver,
    ),
    /APPROVAL_STALE_OR_NOT_FOUND/,
  );

  console.log('STALE_SNAPSHOT_DENIED=PASS');

  // Concurrently submit the same operation.
  const [first, second] = await Promise.all([
    approveQuote(validRequest, env, input, resolver),
    approveQuote(validRequest, env, input, resolver),
  ]);

  assert.equal(first.approvalId, second.approvalId);

  assert.equal(
    [first, second].filter(x => !x.replayed).length,
    1,
  );

  assert.equal(first.paymentInitiated, false);
  assert.equal(second.paymentInitiated, false);

  console.log('CONCURRENT_APPROVAL_REPLAY=PASS');

  const retry = await approveQuote(
    validRequest, env, input, resolver,
  );

  assert.equal(retry.replayed, true);
  assert.equal(retry.approvalId, first.approvalId);

  console.log('IDEMPOTENT_RETRY=PASS');

  await assert.rejects(
    approveQuote(
      validRequest,
      env,
      { ...input, idempotencyKey: otherKey },
      resolver,
    ),
    /APPROVAL_NOT_COMMITTED/,
  );

  console.log('SECOND_KEY_SAME_QUOTE_DENIED=PASS');

  async function count(table) {
    const allowed = new Set([
      'approvals', 'approval_idempotency', 'audit_events',
    ]);

    assert.ok(allowed.has(table));

    const row = await DB.prepare(
      `SELECT COUNT(*) AS n FROM ${table}`,
    ).first();

    return row.n;
  }

  assert.equal(await count('approvals'), 1);
  assert.equal(await count('approval_idempotency'), 1);
  assert.equal(await count('audit_events'), 1);

  const approval = await DB.prepare(`
    SELECT approved_by,revision_no,snapshot_sha256
    FROM approvals WHERE quote_id=?
  `).bind(quoteId).first();

  assert.equal(approval.approved_by, actor);
  assert.equal(approval.revision_no, 1);
  assert.equal(approval.snapshot_sha256, hash);

  const audit = await DB.prepare(`
    SELECT action,actor_id
    FROM audit_events WHERE entity_id=?
  `).bind(quoteId).first();

  assert.equal(audit.action, 'QUOTE_APPROVED');
  assert.equal(audit.actor_id, actor);

  console.log('APPROVAL_LEDGER_AUDIT_COUNTS=1_1_1');
  console.log('SNAPSHOT_AND_ACTOR_BINDING=PASS');
  console.log('PAYMENT_INITIATED=FALSE');
  console.log('D1_RUNTIME_INTEGRATION=PASS');
} finally {
  if (platform) {
    await platform.dispose();
  }
}
