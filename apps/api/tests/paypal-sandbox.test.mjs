import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifySandboxInvoicing,
} from '../src/paypal/sandbox.ts';

const env = {
  PAYPAL_ENVIRONMENT: 'SANDBOX',
  PAYPAL_CLIENT_ID: 'test-client',
  PAYPAL_CLIENT_SECRET: 'test-secret',
};

const oauth = () => ({
  access_token: 'mock-access-token',
  token_type: 'Bearer',
  scope:
    'https://uri.paypal.com/services/invoicing',
});

const reply = (value, status = 200) =>
  new Response(JSON.stringify(value), { status });

test('uses only approved Sandbox read operations', async () => {
  const requests = [];

  const fakeFetch = async (url, options) => {
    requests.push({ url, options });

    return requests.length === 1
      ? reply(oauth())
      : reply({ items: [] });
  };

  const result = await verifySandboxInvoicing(
    env,
    fakeFetch,
  );

  assert.deepEqual(result, {
    oauthAuthenticated: true,
    invoicingScope: true,
    invoiceReadAccess: true,
  });

  assert.deepEqual(
    requests.map(x => x.url),
    [
      'https://api-m.sandbox.paypal.com/v1/oauth2/token',
      'https://api-m.sandbox.paypal.com/v2/invoicing/invoices?page=1&page_size=1',
    ],
  );

  assert.deepEqual(
    requests.map(x => x.options.method),
    ['POST', 'GET'],
  );

  assert.ok(
    requests.every(x => x.options.redirect === 'error'),
  );

  assert.ok(
    requests[0].options.headers.Authorization
      .startsWith('Basic '),
  );

  assert.equal(
    requests[1].options.headers.Authorization,
    'Bearer mock-access-token',
  );
});

test('rejects Live configuration without network access', async () => {
  let called = false;

  await assert.rejects(
    verifySandboxInvoicing(
      { ...env, PAYPAL_ENVIRONMENT: 'LIVE' },
      async () => {
        called = true;
        throw Error('unexpected');
      },
    ),
    /PAYPAL_SANDBOX_ONLY/,
  );

  assert.equal(called, false);
});

test('rejects missing credentials before network access', async () => {
  let called = false;

  await assert.rejects(
    verifySandboxInvoicing(
      { ...env, PAYPAL_CLIENT_SECRET: '' },
      async () => {
        called = true;
        throw Error('unexpected');
      },
    ),
    /PAYPAL_CREDENTIALS_MISSING_OR_INVALID/,
  );

  assert.equal(called, false);
});

test('sanitizes rejected OAuth responses', async () => {
  await assert.rejects(
    verifySandboxInvoicing(
      env,
      async () => reply({
        message: 'secret-bearing upstream error',
      }, 401),
    ),
    /^Error: PAYPAL_SANDBOX_OAUTH_REJECTED$/,
  );
});

test('requires Invoicing scope before invoice access', async () => {
  let called = 0;

  await assert.rejects(
    verifySandboxInvoicing(env, async () => {
      called++;

      return reply({
        ...oauth(),
        scope: 'openid',
      });
    }),
    /PAYPAL_SANDBOX_INVOICING_SCOPE_MISSING/,
  );

  assert.equal(called, 1);
});

test('rejects inaccessible invoice listing', async () => {
  let called = 0;

  await assert.rejects(
    verifySandboxInvoicing(env, async () =>
      ++called === 1
        ? reply(oauth())
        : reply({
            debug_secret: 'not-public',
          }, 403),
    ),
    /^Error: PAYPAL_SANDBOX_INVOICING_READ_REJECTED$/,
  );
});

test('sanitizes transport failures', async () => {
  await assert.rejects(
    verifySandboxInvoicing(env, async () => {
      throw Error('sensitive network details');
    }),
    /^Error: PAYPAL_SANDBOX_NETWORK_ERROR$/,
  );
});
