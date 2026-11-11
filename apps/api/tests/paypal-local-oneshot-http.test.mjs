import test from 'node:test';
import assert from 'node:assert/strict';
import { localSandboxOneShotHttp } from '../src/paypal/local-sandbox-oneshot-http.ts';

const BASE = 'http://127.0.0.1:8787';
const PATH = '/api/local/paypal/sandbox-draft-oneshot';

const enabled = {
  TRADETRUST_PAYPAL_HTTP_MODE: 'LOCAL_ONESHOT_APPROVED',
  TRADETRUST_AUTH_MODE: 'LOCAL_SESSION',
  PAYPAL_ENVIRONMENT: 'SANDBOX',
  PAYPAL_DRAFT_CREATE_MODE: 'SANDBOX_REAL_ONE_DRAFT',
  TRADETRUST_SANDBOX_EXECUTION_MODE: 'LOCAL_SANDBOX_DRAFT_ONESHOT',
  DB: {
    prepare() {
      throw Error('DB_SHOULD_NOT_BE_CALLED');
    }
  },
};

const readBody = request => request.text();

function request(overrides = {}) {
  return new Request(
    overrides.url || BASE + PATH,
    {
      method: overrides.method || 'POST',
      headers: {
        Origin: overrides.origin || BASE,
        'Content-Type': overrides.contentType || 'application/json',
      },
      body: overrides.method === 'GET'
        ? undefined
        : (overrides.body ?? '{}'),
    }
  );
}

test('route is disabled without the independent HTTP gate', async () => {
  const env = { ...enabled, TRADETRUST_PAYPAL_HTTP_MODE: undefined };
  const res = await localSandboxOneShotHttp(request(), env, readBody);
  assert.equal(res.status, 404);
});

test('route is disabled if the provider execution gate is absent', async () => {
  const env = { ...enabled, PAYPAL_DRAFT_CREATE_MODE: undefined };
  const res = await localSandboxOneShotHttp(request(), env, readBody);
  assert.equal(res.status, 404);
});

test('rejects a non-local URL', async () => {
  const res = await localSandboxOneShotHttp(
    request({ url: 'http://example.test' + PATH }),
    enabled, readBody
  );
  assert.equal(res.status, 404);
});

test('rejects GET without invoking the payment bridge', async () => {
  const res = await localSandboxOneShotHttp(
    request({ method: 'GET' }), enabled, readBody
  );
  assert.equal(res.status, 405);
});

test('rejects cross-origin POST without invoking the bridge', async () => {
  const res = await localSandboxOneShotHttp(
    request({ origin: 'http://example.test' }),
    enabled, readBody
  );
  assert.equal(res.status, 403);
});

test('rejects non-JSON requests', async () => {
  const res = await localSandboxOneShotHttp(
    request({ contentType: 'text/plain' }),
    enabled, readBody
  );
  assert.equal(res.status, 415);
});

test('rejects client-supplied commercial fields', async () => {
  const res = await localSandboxOneShotHttp(
    request({ body: '{"amount":"1.00"}' }),
    enabled, readBody
  );
  assert.equal(res.status, 400);
});

test('rejects query parameters on the one-shot route', async () => {
  const res = await localSandboxOneShotHttp(
    request({ url: BASE + PATH + '?approvalId=other' }),
    enabled, readBody
  );
  assert.equal(res.status, 404);
});
