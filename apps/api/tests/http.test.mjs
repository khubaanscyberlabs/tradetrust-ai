import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleRequest,
} from '../src/index.ts';

const url =
  'http://127.0.0.1:8787/api/quotes/preview';

const valid = () => JSON.stringify({
  items: [
    { sku: 'OUTFIT-01', quantity: 2 },
  ],
  shipping: 'standard',
});

const request = (
  body,
  headers = { 'Content-Type': 'application/json' },
) => new Request(url, {
  method: 'POST',
  headers,
  body,
});

test('health endpoint', async () => {
  const response = await handleRequest(
    new Request('http://127.0.0.1:8787/health'),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    { status: 'ok' },
  );
});

test('validated quote cannot initiate payment', async () => {
  const response = await handleRequest(
    request(valid()),
  );

  assert.equal(response.status, 200);

  const result = await response.json();

  assert.equal(result.quote.totalCents, 10900);
  assert.equal(
    result.quote.status,
    'PROPOSAL_REQUIRES_MERCHANT_APPROVAL',
  );

  assert.match(result.note, /No payment/);
  assert.equal(
    response.headers.get('Cache-Control'),
    'no-store',
  );
});

test('rejects forged unit price', async () => {
  const response = await handleRequest(
    request(JSON.stringify({
      items: [{
        sku: 'OUTFIT-01',
        quantity: 2,
        unitCents: 1,
      }],
      shipping: 'standard',
    })),
  );

  assert.equal(response.status, 422);
});

test('rejects client-controlled total', async () => {
  const response = await handleRequest(
    request(JSON.stringify({
      items: [{
        sku: 'OUTFIT-01',
        quantity: 2,
      }],
      shipping: 'standard',
      totalCents: 1,
    })),
  );

  assert.equal(response.status, 422);
});

test('rejects malformed JSON', async () => {
  const response = await handleRequest(
    request('{invalid'),
  );

  assert.equal(response.status, 400);
});

test('rejects unsupported content type', async () => {
  const response = await handleRequest(
    request(valid(), {}),
  );

  assert.equal(response.status, 415);
});

test('rejects oversized request body', async () => {
  const response = await handleRequest(
    request('x'.repeat(9000)),
  );

  assert.equal(response.status, 413);
});

test('unknown endpoints return 404', async () => {
  const response = await handleRequest(
    new Request(
      'http://127.0.0.1:8787/api/payments/capture',
    ),
  );

  assert.equal(response.status, 404);
});

test('unsupported HTTP methods return 405', async () => {
  const response = await handleRequest(
    new Request(url),
  );

  assert.equal(response.status, 405);
  assert.equal(
    response.headers.get('Allow'),
    'POST',
  );
});

test('does not expose permissive CORS', async () => {
  const response = await handleRequest(
    request(valid(), {
      'Content-Type': 'application/json',
      'Origin': 'https://attacker.example',
    }),
  );

  assert.equal(
    response.headers.get('Access-Control-Allow-Origin'),
    null,
  );
});

test('merchant approval API is not implemented', async () => {
  const response = await handleRequest(
    new Request(
      'http://127.0.0.1:8787/api/quotes/approve',
      { method: 'POST' },
    ),
  );

  assert.equal(response.status, 404);
});
