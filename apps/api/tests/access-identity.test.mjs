import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
} from 'jose';

import {
  verifyAccessHuman,
} from '../src/auth/access-identity.ts';

const TEAM = 'https://demo.cloudflareaccess.com';
const AUD = 'a'.repeat(64);

const config = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
};

const keys = (async () => {
  const pair = await generateKeyPair('RS256', {
    extractable: true,
  });

  const jwk = await exportJWK(pair.publicKey);

  const resolver = createLocalJWKSet({
    keys: [{
      ...jwk,
      kid: 'synthetic-key-1',
      use: 'sig',
      alg: 'RS256',
    }],
  });

  return { pair, resolver };
})();

async function token(overrides = {}, header = {}) {
  const { pair } = await keys;
  const now = Math.floor(Date.now() / 1000);

  const claims = {
    iss: TEAM,
    aud: [AUD],
    sub: 'synthetic-human-001',
    type: 'app',
    email: 'owner@example.test',
    iat: now,
    nbf: now - 10,
    exp: now + 3600,
    ...overrides,
  };

  return new SignJWT(claims)
    .setProtectedHeader({
      alg: 'RS256',
      kid: 'synthetic-key-1',
      ...header,
    })
    .sign(pair.privateKey);
}

function request(jwt) {
  return new Request(
    'http://127.0.0.1:8787/api/merchant/approve',
    jwt
      ? { headers: { 'Cf-Access-Jwt-Assertion': jwt } }
      : {},
  );
}

async function verify(jwt, cfg = config) {
  const { resolver } = await keys;

  return verifyAccessHuman(
    request(jwt),
    cfg,
    resolver,
  );
}

async function denied(jwt, cfg = config) {
  await assert.rejects(
    verify(jwt, cfg),
    /ACCESS_IDENTITY_REJECTED|ACCESS_CONFIGURATION_INVALID/,
  );
}

test('accepts genuine signed synthetic human', async () => {
  const identity = await verify(await token());

  assert.deepEqual(identity, {
    provider: 'CLOUDFLARE_ACCESS',
    issuer: TEAM,
    subject: 'synthetic-human-001',
  });

  assert.equal('email' in identity, false);
});

test('rejects missing identity assertion', async () => {
  await denied(null);
});

test('rejects invalid signature', async () => {
  const jwt = await token();
  const parts = jwt.split('.');
  const s = parts[2];

  parts[2] =
    (s[0] === 'A' ? 'B' : 'A') + s.slice(1);

  await denied(parts.join('.'));
});

test('rejects wrong application audience', async () => {
  await denied(await token({
    aud: ['b'.repeat(64)],
  }));
});

test('rejects wrong Cloudflare team', async () => {
  await denied(await token({
    iss: 'https://other.cloudflareaccess.com',
  }));
});

test('rejects expired identity', async () => {
  const now = Math.floor(Date.now() / 1000);

  await denied(await token({
    iat: now - 3600,
    nbf: now - 3600,
    exp: now - 60,
  }));
});

test('rejects not-yet-valid identity', async () => {
  const now = Math.floor(Date.now() / 1000);

  await denied(await token({
    nbf: now + 3600,
  }));
});

test('rejects service-token identity', async () => {
  await denied(await token({
    sub: '',
    email: undefined,
    common_name: 'synthetic-service.access',
  }));
});

test('rejects non-app session tokens', async () => {
  await denied(await token({ type: 'org' }));
});

test('rejects missing human email', async () => {
  await denied(await token({ email: undefined }));
});

test('rejects unrecognized signing key', async () => {
  await denied(
    await token({}, { kid: 'unrecognized-key' }),
  );
});

test('rejects invalid Access configuration', async () => {
  await denied(await token(), {
    ACCESS_TEAM_DOMAIN: 'https://attacker.example',
    ACCESS_AUD: AUD,
  });
});

test('rejects future-issued identity', async () => {
  const now = Math.floor(Date.now() / 1000);

  await denied(await token({
    iat: now + 3600,
    exp: now + 7200,
  }));
});
