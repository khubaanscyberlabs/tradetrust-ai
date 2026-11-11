import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCloudflareNegotiationRequest, interpretCloudflareNegotiationAdvisory } from '../src/ai/cloudflare-provider.ts';
import { readFileSync } from 'node:fs';

const ctx = {merchantId:'merchant-local-demo', quoteId:'21c50c14-fe6b-4c5f-9811-aee5306aa38c', quoteSha256:'225b8ff7fb7f90ca06c80ce809409ee5d524590ce506b189c566c24bddbd5235', currency:'USD', maxDiscountBps:500};
const modelOutput = (discount_bps) => ({response:JSON.stringify({reply:'Please review this request.', intent:'REQUEST_DISCOUNT', discount_bps, shipping:'UNCHANGED'})});

test('JSON object mode is enabled for the supported Cloudflare model', () => {
  const req = buildCloudflareNegotiationRequest(ctx, 'Can we discuss shipping and discount?');
  assert.equal(req.model,'@cf/google/gemma-4-26b-a4b-it');
  assert.deepEqual(req.request.response_format,{type:'json_object'});
  assert.equal(req.request.stream,false);
  assert.equal(req.request.max_completion_tokens,250);
  assert.equal(req.request.chat_template_kwargs.enable_thinking,false);
});

test('JSON model response remains nonbinding within server policy', () => {
  const result = interpretCloudflareNegotiationAdvisory(modelOutput(400),500);
  assert.equal(result.source,'CLOUDFLARE_MODEL_OUTPUT_UNVERIFIED');
  assert.equal(result.policyDecision,'WITHIN_POLICY');
  assert.equal(result.executableOfferAllowed,false);
  assert.equal(result.merchantApprovalRecorded,false);
  assert.equal(result.paymentInitiated,false);
});

test('8 percent response cannot exceed the 5 percent advisory policy', () => {
  const result = interpretCloudflareNegotiationAdvisory(modelOutput(800),500);
  assert.equal(result.source,'CLOUDFLARE_MODEL_OUTPUT_UNVERIFIED');
  assert.equal(result.policyDecision,'NEEDS_MERCHANT_REVIEW');
  assert.equal(result.executableOfferAllowed,false);
  assert.equal(result.paymentInitiated,false);
});

test('Malformed model output triggers the fixed safe fallback', () => {
  const result = interpretCloudflareNegotiationAdvisory({response:'```json\n{}\n```'},500);
  assert.equal(result.source,'LOCAL_SAFE_FALLBACK');
  assert.equal(result.policyDecision,'NEEDS_MERCHANT_REVIEW');
  assert.equal(result.nonBinding,true);
  assert.equal(result.paymentInitiated,false);
});

test('Trusted bridge emits only three fixed diagnostic categories', () => {
  const source = readFileSync(new URL('../src/ai/trusted-cloudflare-binding.ts',import.meta.url),'utf8');
  const matches=[...source.matchAll(/TRADETRUST_CF_AI_DIAGNOSTIC=[A-Z_]+/g)].map(x=>x[0]);
  assert.deepEqual(matches.sort(),[
    'TRADETRUST_CF_AI_DIAGNOSTIC=MODEL_OUTPUT_ACCEPTED',
    'TRADETRUST_CF_AI_DIAGNOSTIC=MODEL_OUTPUT_REJECTED',
    'TRADETRUST_CF_AI_DIAGNOSTIC=PROVIDER_EXCEPTION'
  ]);
  assert.ok(!/console\.(log|warn|error)\s*\(/.test(source));
});
