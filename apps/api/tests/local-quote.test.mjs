import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/index.ts';

const URL = 'http://127.0.0.1:8787/api/dev/quotes';

const sample = () => new Request(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items: [{ sku: 'OUTFIT-01', quantity: 2 }],
    shipping: 'standard',
  }),
});

test('local persistence is disabled without configuration', async () => {
  const response = await handleRequest(sample());
  assert.equal(response.status, 404);
});

test('local persistence is disabled without a secret', async () => {
  const response = await handleRequest(sample(), {
    LOCAL_DEALROOM_MODE: 'enabled',
  });
  assert.equal(response.status, 404);
});

test('local persistence requires its private token', async () => {
  const response = await handleRequest(sample(), {
    LOCAL_DEALROOM_MODE: 'enabled',
    LOCAL_DEALROOM_TOKEN: 'a'.repeat(64),
  });
  assert.equal(response.status, 401);
});

test('local persistence is not available on external hostname', async () => {
  const request = new Request(
    'https://example.com/api/dev/quotes',
    { method: 'POST' },
  );

  const response = await handleRequest(request, {
    LOCAL_DEALROOM_MODE: 'enabled',
    LOCAL_DEALROOM_TOKEN: 'a'.repeat(64),
  });

  assert.equal(response.status, 404);
});
