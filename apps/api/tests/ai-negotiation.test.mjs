import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestNegotiationMockOnly } from '../src/ai/negotiation.ts';

const env = Object.freeze({
  TRADETRUST_AI_MODE: 'MOCK_ONLY',
  OPENAI_MODEL: 'test-model-v1',
  OPENAI_API_KEY: 'test-only-not-a-real-key',
});
const context = Object.freeze({
  merchantId: 'merchant-1',
  quoteId: 'quote-1',
  quoteSha256: 'a'.repeat(64),
  currency: 'USD',
  maxDiscountBps: 500,
});
const message = 'Could you offer a 4 percent discount?';
const decision = {
  reply: 'I can submit your discount request for merchant review.',
  intent: 'REQUEST_DISCOUNT',
  discount_bps: 400,
  shipping: 'UNCHANGED',
};
function provider(output = decision) {
  return {
    status: 'completed',
    output: [{
      type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(output) }],
    }],
  };
}
function fakeNetwork(payload = provider(), opts = {}) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    if (opts.throws) throw Error('upstream network failed with sensitive credentials');
    return new Response(opts.raw ?? JSON.stringify(payload), {
      status: opts.status ?? 200,
      headers: opts.headers ?? { 'Content-Type': 'application/json' },
    });
  };
  return { calls, transport };
}
async function rejects(code, args) {
  await assert.rejects(
    () => suggestNegotiationMockOnly(...args),
    error => error instanceof Error && error.message === code,
  );
}

test('mocked Responses API sends structured schema and returns nonbinding discount intent', async () => {
  const { transport, calls } = fakeNetwork();
  const result = await suggestNegotiationMockOnly(env, context, message, transport);
  assert.equal(result.discountBps, 400);
  assert.equal(result.policyDecision, 'WITHIN_POLICY');
  assert.equal(result.nonBinding, true);
  assert.equal(result.source, 'MOCKED_MODEL');
  assert(Object.isFrozen(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert(calls[0].init.signal instanceof AbortSignal);
  const req = JSON.parse(calls[0].init.body);
  assert.equal(req.store, false);
  assert.equal(req.tool_choice, 'none');
  assert.equal(req.text.format.strict, true);
  assert.equal(req.text.format.schema.additionalProperties, false);
  assert.equal(req.input[0].content[0].text, message);
  assert.equal(req.model, 'test-model-v1');
  assert(!JSON.stringify(req).includes('merchant-1'));
  assert(!JSON.stringify(req).includes('quote-1'));
  assert(!JSON.stringify(req).includes(context.quoteSha256));
});

test('requests exceeding merchant discount policy require review; never auto-approve', async () => {
  const { transport } = fakeNetwork(provider({ ...decision, discount_bps: 800 }));
  const result = await suggestNegotiationMockOnly(env, context, message, transport);
  assert.equal(result.policyDecision, 'NEEDS_MERCHANT_REVIEW');
  assert.equal(result.discountBps, 800);
  assert.equal(result.nonBinding, true);
});

test('10000 bps never becomes an executable offer', async () => {
  const { transport } = fakeNetwork(provider({ ...decision, discount_bps: 10000 }));
  const result = await suggestNegotiationMockOnly(env, context, message, transport);
  assert.equal(result.policyDecision, 'NEEDS_MERCHANT_REVIEW');
  assert(!Object.hasOwn(result, 'totalCents'));
  assert(!Object.hasOwn(result, 'approvalId'));
  assert(!Object.hasOwn(result, 'invoiceId'));
});

test('disabled gate fails before calling transport', async () => {
  const f = fakeNetwork();
  await rejects('TRADETRUST_AI_EXECUTION_DENIED', [{ ...env, TRADETRUST_AI_MODE: 'OFF' }, context, message, f.transport]);
  assert.equal(f.calls.length, 0);
});

test('missing gate denies execution', async () => {
  const f = fakeNetwork();
  await rejects('TRADETRUST_AI_EXECUTION_DENIED', [undefined, context, message, f.transport]);
  assert.equal(f.calls.length, 0);
});

test('REAL mode is not enabled even with an injected transport', async () => {
  const f = fakeNetwork();
  await rejects('TRADETRUST_AI_EXECUTION_DENIED', [{ ...env, TRADETRUST_AI_MODE: 'REAL' }, context, message, f.transport]);
  assert.equal(f.calls.length, 0);
});

test('non-sentinel API key denied by mock gate', async () => {
  const f = fakeNetwork();
  await rejects('TRADETRUST_AI_EXECUTION_DENIED', [{ ...env, OPENAI_API_KEY: 'not-a-real-key-negative-test-fixture' }, context, message, f.transport]);
  assert.equal(f.calls.length, 0);
});

test('direct global fetch cannot be injected as mock transport', async () => {
  await rejects('TRADETRUST_AI_EXECUTION_DENIED', [env, context, message, fetch]);
});

test('missing explicitly injected transport fails closed', async () => {
  await rejects('TRADETRUST_AI_EXECUTION_DENIED', [env, context, message]);
});

test('rejects malformed trusted quote binding', async () => {
  const f = fakeNetwork();
  await rejects('TRADETRUST_AI_TRUSTED_CONTEXT_INVALID', [env, { ...context, quoteSha256: 'bad' }, message, f.transport]);
  assert.equal(f.calls.length, 0);
});

test('rejects attacker-injected client total field in trusted context', async () => {
  const f = fakeNetwork();
  await rejects('TRADETRUST_AI_TRUSTED_CONTEXT_INVALID', [env, { ...context, totalCents: 1 }, message, f.transport]);
  assert.equal(f.calls.length, 0);
});

test('rejects unsafe monetary policy bps', async () => {
  const f = fakeNetwork();
  await rejects('TRADETRUST_AI_TRUSTED_CONTEXT_INVALID', [env, { ...context, maxDiscountBps: 500.5 }, message, f.transport]);
  assert.equal(f.calls.length, 0);
});

test('rejects oversized buyer input before provider call', async () => {
  const f = fakeNetwork();
  await rejects('TRADETRUST_AI_BUYER_MESSAGE_INVALID', [env, context, 'a'.repeat(1001), f.transport]);
  assert.equal(f.calls.length, 0);
});

test('rejects a model-provided client total field', async () => {
  const f = fakeNetwork(provider({ ...decision, total_cents: 1 }));
  await rejects('TRADETRUST_AI_RESPONSE_INVALID', [env, context, message, f.transport]);
});

test('rejects negative or fractional model discount', async () => {
  for (const discount_bps of [-1, 200.5, 10001]) {
    const f = fakeNetwork(provider({ ...decision, discount_bps }));
    await rejects('TRADETRUST_AI_RESPONSE_INVALID', [env, context, message, f.transport]);
  }
});

test('rejects malformed or unknown assistant intent', async () => {
  const f = fakeNetwork(provider({ ...decision, intent: 'EXECUTE_PAYMENT' }));
  await rejects('TRADETRUST_AI_RESPONSE_INVALID', [env, context, message, f.transport]);
});

test('rejects forged shipping choice', async () => {
  const f = fakeNetwork(provider({ ...decision, shipping: 'FREE_OVERNIGHT' }));
  await rejects('TRADETRUST_AI_RESPONSE_INVALID', [env, context, message, f.transport]);
});

test('rejects tool-call output and partial status', async () => {
  const payload = provider();
  payload.output = [{ type: 'function_call', name: 'create_invoice' }];
  const f = fakeNetwork(payload);
  await rejects('TRADETRUST_AI_RESPONSE_INVALID', [env, context, message, f.transport]);
  const g = fakeNetwork({ ...provider(), status: 'incomplete' });
  await rejects('TRADETRUST_AI_RESPONSE_INVALID', [env, context, message, g.transport]);
});

test('rejects provider refusal', async () => {
  const payload = provider();
  payload.output[0].content = [{ type: 'refusal', refusal: 'I cannot help' }];
  const f = fakeNetwork(payload);
  await rejects('TRADETRUST_AI_RESPONSE_INVALID', [env, context, message, f.transport]);
});

test('scrubs upstream failures', async () => {
  const f = fakeNetwork(provider(), { throws: true });
  await rejects('TRADETRUST_AI_UPSTREAM_UNAVAILABLE', [env, context, message, f.transport]);
});

test('fails closed on failed HTTP responses and bad JSON', async () => {
  const f = fakeNetwork(provider(), { status: 401 });
  await rejects('TRADETRUST_AI_UPSTREAM_UNAVAILABLE', [env, context, message, f.transport]);
  const g = fakeNetwork(provider(), { raw: '{bad-json' });
  await rejects('TRADETRUST_AI_RESPONSE_INVALID', [env, context, message, g.transport]);
});

test('rejects long model reply and invalid model names', async () => {
  const f = fakeNetwork(provider({ ...decision, reply: 'x'.repeat(601) }));
  await rejects('TRADETRUST_AI_RESPONSE_INVALID', [env, context, message, f.transport]);
  const g = fakeNetwork();
  await rejects('TRADETRUST_AI_EXECUTION_DENIED', [{ ...env, OPENAI_MODEL: '../../bad' }, context, message, g.transport]);
  assert.equal(g.calls.length, 0);
});

test('none of the source contains a public endpoint or D1 writes', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/ai/negotiation.ts', import.meta.url), 'utf8');
  assert(!/\.prepare\s*\(|\.run\s*\(|\.fetch\s*\(|fetch\s*\(/.test(src));
  assert(!/router\.|app\.post\(|new URLPattern\s*\(/.test(src));
  assert(!src.includes('https://api-m.paypal.com'));
});
