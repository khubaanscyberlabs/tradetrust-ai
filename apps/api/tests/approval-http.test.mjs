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
  approvalHttpEndpoint,
} from '../src/approval-http.ts';

import { handleRequest } from '../src/index.ts';

const ORIGIN = 'https://merchant.example.test';
const TEAM = 'https://demo.cloudflareaccess.com';
const AUD = 'a'.repeat(64);

const validInput = () => ({
  merchantId: 'merchant-A',
  quoteId: 'quote-A',
  revision: 1,
  snapshotSha256: 'a'.repeat(64),
  idempotencyKey:
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
});

const keys = (async () => {
  const pair = await generateKeyPair('RS256', {
    extractable: true,
  });

  const jwk = await exportJWK(pair.publicKey);

  return {
    privateKey: pair.privateKey,
    resolver: createLocalJWKSet({
      keys: [{
        ...jwk,
        kid: 'http-test-key',
        alg: 'RS256',
        use: 'sig',
      }],
    }),
  };
})();

async function humanToken(subject = 'human-owner') {
  const { privateKey } = await keys;
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
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
      kid: 'http-test-key',
    })
    .sign(privateKey);
}

function makeRequest(
  body = validInput(),
  options = {},
) {
  const method = options.method ?? 'POST';

  const headers = {
    Origin: options.origin ?? ORIGIN,
    'Content-Type':
      options.contentType ?? 'application/json',
  };

  if (options.token) {
    headers['Cf-Access-Jwt-Assertion'] = options.token;
  }

  return new Request(
    `${ORIGIN}/api/merchant/approve`,
    {
      method,
      headers,
      ...(method === 'POST'
        ? {
            body: typeof body === 'string'
              ? body
              : JSON.stringify(body),
          }
        : {}),
    },
  );
}

function setupDatabase() {
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
  ).run('merchant-A', 'Synthetic Merchant');

  raw.prepare(
    'INSERT INTO dealrooms(id,merchant_id) VALUES(?,?)',
  ).run('room-A', 'merchant-A');

  raw.prepare(
    'INSERT INTO quotes(id,merchant_id,dealroom_id) VALUES(?,?,?)',
  ).run('quote-A', 'merchant-A', 'room-A');

  raw.prepare(`
    INSERT INTO quote_revisions(
      quote_id,merchant_id,revision_no,currency,
      subtotal_cents,discount_cents,shipping_cents,
      total_cents,snapshot_json,snapshot_sha256
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    'quote-A', 'merchant-A', 1,
    'USD', 8400, 0, 2500, 10900,
    '{}', 'a'.repeat(64),
  );

  raw.prepare(`
    INSERT INTO merchant_actors(
      id,provider,issuer,subject
    ) VALUES(?,?,?,?)
  `).run(
    'actor-owner',
    'CLOUDFLARE_ACCESS',
    TEAM,
    'human-owner',
  );

  raw.prepare(`
    INSERT INTO merchant_memberships(
      merchant_id,actor_id,role
    ) VALUES(?,?,?)
  `).run(
    'merchant-A', 'actor-owner', 'OWNER',
  );

  const prepare = (sql, values = []) => ({
    bind(...next) {
      return prepare(sql, next);
    },
    async first() {
      return raw.prepare(sql).get(...values) ?? null;
    },
    run() {
      return raw.prepare(sql).run(...values);
    },
  });

  const DB = {
    prepare,
    async batch(statements) {
      raw.exec('BEGIN IMMEDIATE');

      try {
        const result = statements.map(statement => {
          statement.run();
          return { success: true };
        });

        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };

  return {
    raw,
    env: {
      DB,
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      APPROVAL_API_MODE: 'enabled',
      APPROVAL_ALLOWED_ORIGIN: ORIGIN,
    },
  };
}

async function invoke(request, env) {
  const { resolver } = await keys;

  return approvalHttpEndpoint(
    request,
    env,
    r => r.text(),
    resolver,
  );
}

test('router hides approval endpoint by default', async () => {
  const response = await handleRequest(
    makeRequest(),
  );

  assert.equal(response.status, 404);
});

test('missing origin configuration disables route', async () => {
  const { env } = setupDatabase();

  delete env.APPROVAL_ALLOWED_ORIGIN;

  const response = await invoke(makeRequest(), env);
  assert.equal(response.status, 404);
});

test('GET is not an approval operation', async () => {
  const { env } = setupDatabase();

  const response = await invoke(
    makeRequest(undefined, { method: 'GET' }),
    env,
  );

  assert.equal(response.status, 405);
});

test('rejects cross-site request origins', async () => {
  const { env } = setupDatabase();

  const response = await invoke(
    makeRequest(validInput(), {
      origin: 'https://untrusted.example.test',
    }),
    env,
  );

  assert.equal(response.status, 403);
});

test('rejects non-JSON approval requests', async () => {
  const { env } = setupDatabase();

  const response = await invoke(
    makeRequest(validInput(), {
      contentType: 'text/plain',
    }),
    env,
  );

  assert.equal(response.status, 415);
});

test('rejects malformed JSON', async () => {
  const { env } = setupDatabase();

  const response = await invoke(
    makeRequest('{'),
    env,
  );

  assert.equal(response.status, 400);
});

test('denies unauthenticated approval', async () => {
  const { env } = setupDatabase();

  const response = await invoke(
    makeRequest(),
    env,
  );

  assert.equal(response.status, 403);
});

test('creates approval then replays safely', async () => {
  const { env, raw } = setupDatabase();
  const token = await humanToken();

  const first = await invoke(
    makeRequest(validInput(), { token }),
    env,
  );

  assert.equal(first.status, 201);

  const firstBody = await first.json();
  assert.equal(firstBody.approval.replayed, false);
  assert.equal(
    firstBody.approval.paymentInitiated,
    false,
  );

  const second = await invoke(
    makeRequest(validInput(), { token }),
    env,
  );

  assert.equal(second.status, 200);

  const secondBody = await second.json();

  assert.equal(secondBody.approval.replayed, true);
  assert.equal(
    secondBody.approval.approvalId,
    firstBody.approval.approvalId,
  );

  for (const table of [
    'approvals',
    'approval_idempotency',
  ]) {
    const count = raw.prepare(
      `SELECT COUNT(*) AS n FROM ${table}`,
    ).get().n;

    assert.equal(count, 1);
  }

  assert.equal(
    raw.prepare(
      "SELECT COUNT(*) AS n FROM audit_events"
    ).get().n,
    1,
  );

  assert.equal(
    first.headers.get('Access-Control-Allow-Origin'),
    null,
  );
});

test('same key with a changed snapshot returns conflict', async () => {
  const { env } = setupDatabase();
  const token = await humanToken();

  assert.equal(
    (await invoke(
      makeRequest(validInput(), { token }),
      env,
    )).status,
    201,
  );

  const response = await invoke(
    makeRequest({
      ...validInput(),
      snapshotSha256: 'b'.repeat(64),
    }, { token }),
    env,
  );

  assert.equal(response.status, 409);
});

test('rejects direct financial-field injection', async () => {
  const { env } = setupDatabase();
  const token = await humanToken();

  const response = await invoke(
    makeRequest({
      ...validInput(),
      totalCents: 1,
    }, { token }),
    env,
  );

  assert.equal(response.status, 400);
});

test('rejects stale quote snapshot', async () => {
  const { env } = setupDatabase();
  const token = await humanToken();

  const response = await invoke(
    makeRequest({
      ...validInput(),
      snapshotSha256: 'b'.repeat(64),
    }, { token }),
    env,
  );

  assert.equal(response.status, 409);
});
