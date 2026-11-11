import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
} from 'jose';

import {
  authorizeMerchantApproval,
} from '../src/auth/merchant-authorization.ts';

const TEAM = 'https://demo.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const MERCHANT_A = 'merchant-local-demo';
const MERCHANT_B = 'merchant-other-demo';

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
        kid: 'merchant-auth-test-key',
        alg: 'RS256',
        use: 'sig',
      }],
    }),
  };
})();

const records = [
  {
    actorId: 'actor-owner',
    subject: 'human-owner',
    merchantId: MERCHANT_A,
    role: 'OWNER',
    actorStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
  },
  {
    actorId: 'actor-manager',
    subject: 'human-manager',
    merchantId: MERCHANT_A,
    role: 'MANAGER',
    actorStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
  },
  {
    actorId: 'actor-other',
    subject: 'human-other',
    merchantId: MERCHANT_B,
    role: 'OWNER',
    actorStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
  },
  {
    actorId: 'actor-staff',
    subject: 'human-staff',
    merchantId: MERCHANT_A,
    role: 'STAFF',
    actorStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
  },
  {
    actorId: 'actor-revoked-member',
    subject: 'human-revoked-member',
    merchantId: MERCHANT_A,
    role: 'MANAGER',
    actorStatus: 'ACTIVE',
    membershipStatus: 'REVOKED',
  },
  {
    actorId: 'actor-revoked-actor',
    subject: 'human-revoked-actor',
    merchantId: MERCHANT_A,
    role: 'MANAGER',
    actorStatus: 'REVOKED',
    membershipStatus: 'ACTIVE',
  },
];

function fakeDatabase(fixture = records) {
  const queries = [];

  return {
    queries,
    prepare(sql) {
      assert.match(sql, /FROM merchant_actors/);
      assert.match(sql, /merchant_memberships/);
      assert.match(sql, /m\.merchant_id = \?/);

      return {
        bind(provider, issuer, subject, merchantId) {
          queries.push({
            provider,
            issuer,
            subject,
            merchantId,
          });

          return {
            async first() {
              const record = fixture.find(r =>
                provider === 'CLOUDFLARE_ACCESS' &&
                issuer === TEAM &&
                r.subject === subject &&
                r.merchantId === merchantId &&
                r.actorStatus === 'ACTIVE' &&
                r.membershipStatus === 'ACTIVE' &&
                ['OWNER', 'MANAGER'].includes(r.role)
              );

              return record
                ? {
                    actor_id: record.actorId,
                    role: record.role,
                  }
                : null;
            },
          };
        },
      };
    },
  };
}

async function signedToken(subject) {
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
      kid: 'merchant-auth-test-key',
    })
    .sign(privateKey);
}

function request(jwt) {
  return new Request(
    'http://127.0.0.1:8787/api/merchant/approve',
    jwt
      ? {
          headers: {
            'Cf-Access-Jwt-Assertion': jwt,
          },
        }
      : {},
  );
}

async function authorize(
  subject,
  merchantId = MERCHANT_A,
  database = fakeDatabase(),
  config = {},
) {
  const { resolver } = await keys;

  return authorizeMerchantApproval(
    request(subject ? await signedToken(subject) : null),
    {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      DB: database,
      ...config,
    },
    merchantId,
    resolver,
  );
}

async function denied(subject, merchantId, database, config) {
  await assert.rejects(
    authorize(subject, merchantId, database, config),
    /^Error: MERCHANT_AUTHORIZATION_DENIED$/,
  );
}

test('authorizes active owner for own merchant', async () => {
  const db = fakeDatabase();

  const result = await authorize(
    'human-owner',
    MERCHANT_A,
    db,
  );

  assert.deepEqual(result, {
    actorId: 'actor-owner',
    merchantId: MERCHANT_A,
    role: 'OWNER',
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal('email' in result, false);

  assert.deepEqual(db.queries, [{
    provider: 'CLOUDFLARE_ACCESS',
    issuer: TEAM,
    subject: 'human-owner',
    merchantId: MERCHANT_A,
  }]);
});

test('authorizes active manager', async () => {
  const result = await authorize('human-manager');

  assert.equal(result.role, 'MANAGER');
});

test('denies cross-tenant merchant access', async () => {
  await denied('human-other', MERCHANT_A);
});

test('denies staff approval permissions', async () => {
  await denied('human-staff', MERCHANT_A);
});

test('denies revoked membership', async () => {
  await denied('human-revoked-member', MERCHANT_A);
});

test('denies revoked actor', async () => {
  await denied('human-revoked-actor', MERCHANT_A);
});

test('denies identity without membership', async () => {
  await denied('human-unknown', MERCHANT_A);
});

test('denies missing signed identity', async () => {
  await denied(null, MERCHANT_A);
});

test('denies invalid merchant identifier', async () => {
  await denied(
    'human-owner',
    "merchant-local-demo' OR 1=1 --",
  );
});

test('denies missing database binding', async () => {
  await denied(
    'human-owner',
    MERCHANT_A,
    undefined,
    { DB: undefined },
  );
});

test('denies database query failures', async () => {
  const db = {
    prepare() {
      throw new Error('private-database-failure');
    },
  };

  await denied('human-owner', MERCHANT_A, db);
});

test('denies mismatched Access audience', async () => {
  await denied(
    'human-owner',
    MERCHANT_A,
    fakeDatabase(),
    { ACCESS_AUD: 'b'.repeat(64) },
  );
});
