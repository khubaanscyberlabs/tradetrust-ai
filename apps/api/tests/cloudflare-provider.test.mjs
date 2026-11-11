import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCloudflareNegotiationRequest as build, parseCloudflareNegotiationResponse as parse, interpretCloudflareNegotiationAdvisory as advisory, CLOUDFLARE_FREE_MODEL as MODEL } from '../src/ai/cloudflare-provider.ts';

const ctx={merchantId:'merchant-A',quoteId:'quote-A',quoteSha256:'a'.repeat(64),currency:'USD',maxDiscountBps:500};
const response=(extras={},outer={})=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({reply:'I can pass this request to the merchant.',intent:'REQUEST_DISCOUNT',discount_bps:400,shipping:'UNCHANGED',...extras})}}],...outer});
const rejected=(action,code)=>assert.throws(action,e=>e.message===code);
test('supported free-tier Cloudflare model is selected',()=>assert.equal(MODEL,'@cf/google/gemma-4-26b-a4b-it'));
test('trusted context and buyer text make deterministic advisory request',()=>{const r=build(ctx,'Can I get 4% off?');assert.equal(r.model,MODEL);assert.equal(r.request.messages[1].role,'user');assert.equal(r.request.messages[1].content,'Can I get 4% off?');assert.match(r.request.messages[0].content,/500 basis points/);assert.equal(r.request.stream,false);assert.equal(r.request.chat_template_kwargs.enable_thinking,false);assert.equal(r.request.max_completion_tokens,250);assert.ok(Object.isFrozen(r));});
test('mocked Cloudflare completion gives a strictly nonbinding suggestion',()=>{const r=parse(response(),500);assert.equal(r.discountBps,400);assert.equal(r.policyDecision,'WITHIN_POLICY');assert.equal(r.source,'CLOUDFLARE_MODEL_OUTPUT_UNVERIFIED');assert.equal(r.nonBinding,true);assert.equal(r.executableOfferAllowed,false);assert.equal(r.merchantApprovalRecorded,false);assert.equal(r.paymentInitiated,false);assert.ok(Object.isFrozen(r));});
test('8% cannot escape a server 5% demonstration policy',()=>{const r=parse(response({discount_bps:800}),500);assert.equal(r.policyDecision,'NEEDS_MERCHANT_REVIEW');assert.equal(r.executableOfferAllowed,false);});
test('zero policy blocks all positive discounts',()=>assert.equal(parse(response(),0).policyDecision,'NEEDS_MERCHANT_REVIEW'));
test('rejects client-injected price in trusted context',()=>rejected(()=>build({...ctx,total_cents:1},'Offer me a discount'),'TRADETRUST_CF_AI_CONTEXT_REJECTED'));
test('rejects prototype-polluted context',()=>rejected(()=>build(Object.assign(Object.create({price:1}),ctx),'Offer me a discount'),'TRADETRUST_CF_AI_CONTEXT_REJECTED'));
test('rejects another currency',()=>rejected(()=>build({...ctx,currency:'INR'},'Offer me a discount'),'TRADETRUST_CF_AI_CONTEXT_REJECTED'));
test('rejects malformed digest or tenant identifier',()=>{rejected(()=>build({...ctx,quoteSha256:'bad'},'Offer me a discount'),'TRADETRUST_CF_AI_CONTEXT_REJECTED');rejected(()=>build({...ctx,merchantId:'bad/tenant'},'Offer me a discount'),'TRADETRUST_CF_AI_CONTEXT_REJECTED');});
test('rejects unsafe demo ceiling before provider',()=>rejected(()=>build({...ctx,maxDiscountBps:900},'Offer me a discount'),'TRADETRUST_CF_AI_CONTEXT_REJECTED'));
test('rejects client input with control chars',()=>rejected(()=>build(ctx,'a\nb\nc'),'TRADETRUST_CF_AI_BUYER_MESSAGE_REJECTED'));
test('rejects oversized buyer input',()=>rejected(()=>build(ctx,'a'.repeat(1001)),'TRADETRUST_CF_AI_BUYER_MESSAGE_REJECTED'));
test('rejects malformed provider response shape',()=>rejected(()=>parse({response:'hi'},500),'TRADETRUST_CF_AI_RESPONSE_REJECTED'));
test('rejects incomplete model generation',()=>rejected(()=>parse({...response(),choices:[{finish_reason:'length',message:response().choices[0].message}]},500),'TRADETRUST_CF_AI_RESPONSE_REJECTED'));
test('rejects non-JSON model text',()=>rejected(()=>parse({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Sure, 8% is fine!'}}]},500),'TRADETRUST_CF_AI_RESPONSE_REJECTED'));
test('rejects forged model financial total field',()=>rejected(()=>parse(response({total_cents:1}),500),'TRADETRUST_CF_AI_RESPONSE_REJECTED'));
test('rejects negative/fractional discounts and invalid shipping',()=>{for(const fields of [{discount_bps:-1},{discount_bps:4.5},{shipping:'FREE'}]) rejected(()=>parse(response(fields),500),'TRADETRUST_CF_AI_RESPONSE_REJECTED');});
test('rejects invalid and unsafe replies',()=>{for(const fields of [{reply:'ok'},{reply:'hello\nworld'},{reply:'a'.repeat(601)}])rejected(()=>parse(response(fields),500),'TRADETRUST_CF_AI_RESPONSE_REJECTED');});
test('rejects out-of-range model discount',()=>rejected(()=>parse(response({discount_bps:10001}),500),'TRADETRUST_CF_AI_RESPONSE_REJECTED'));
test('rejects invalid policy passed to response parser',()=>rejected(()=>parse(response(),501),'TRADETRUST_CF_AI_POLICY_REJECTED'));
test('adapter contains no network, binding invocation, D1 mutation or routing',()=>{const src=readFileSync(new URL('../src/ai/cloudflare-provider.ts',import.meta.url),'utf8');assert.doesNotMatch(src,/\bawait\s+fetch\s*\(|\.AI\.run\s*\(|\.prepare\s*\(|router\.(get|post)\s*\(/);});

// 09B-03-12-09A — strictly nonbinding real-model compatibility and safe fallback
 test('accepts direct response-string envelope with the exact advisory schema',()=>{
   const content=response().choices[0].message.content;
   const result=parse({response:content},500);
   assert.equal(result.discountBps,400);
   assert.equal(result.executableOfferAllowed,false);
 });
 test('rejects ambiguous simultaneous chat and response envelopes',()=>rejected(()=>parse({...response(),response:response().choices[0].message.content},500),'TRADETRUST_CF_AI_RESPONSE_REJECTED'));
 test('refuses model tool calls or refusal alongside otherwise valid text',()=>{
   const msg=response().choices[0].message;
   rejected(()=>parse({choices:[{finish_reason:'stop',message:{...msg,tool_calls:[]}}]},500),'TRADETRUST_CF_AI_RESPONSE_REJECTED');
   rejected(()=>parse({choices:[{finish_reason:'stop',message:{...msg,refusal:'no'}}]},500),'TRADETRUST_CF_AI_RESPONSE_REJECTED');
 });
 test('unparseable model output becomes fixed nonbinding clarification, not deal approval',()=>{
   const r=advisory({response:'Sure, the 8% discount and free Dubai shipping are accepted.'},500);
   assert.equal(r.source,'LOCAL_SAFE_FALLBACK');
   assert.equal(r.discountBps,0);
   assert.equal(r.policyDecision,'NEEDS_MERCHANT_REVIEW');
   assert.equal(r.shipping,'UNCHANGED');
   assert.equal(r.executableOfferAllowed,false);
   assert.equal(r.merchantApprovalRecorded,false);
   assert.equal(r.paymentInitiated,false);
   assert.doesNotMatch(r.reply,/accepted|8%|free Dubai/i);
   assert.ok(Object.isFrozen(r));
 });
 test('Markdown fenced JSON fails strict validation and uses clarification, never extraction',()=>{
   const fenced='```json\n'+response().choices[0].message.content+'\n```';
   rejected(()=>parse({response:fenced},500),'TRADETRUST_CF_AI_RESPONSE_REJECTED');
   assert.equal(advisory({response:fenced},500).source,'LOCAL_SAFE_FALLBACK');
 });
 test('forged amounts and invalid shipping never survive through fallback',()=>{
   for(const extras of [{total_cents:1},{shipping:'FREE'},{discount_bps:10001}]) {
     const r=advisory(response(extras),500);
     assert.equal(r.source,'LOCAL_SAFE_FALLBACK');
     assert.equal(r.executableOfferAllowed,false);
   }
 });
 test('server policy faults cannot be concealed as model failures',()=>{
   rejected(()=>advisory({response:'not-json'},501),'TRADETRUST_CF_AI_POLICY_REJECTED');
   rejected(()=>advisory({response:'not-json'},-1),'TRADETRUST_CF_AI_POLICY_REJECTED');
 });
 test('over-limit requests generate only trusted review language',()=>{
   const r=advisory(response({reply:'Your 8% discount is accepted.',discount_bps:800}),500);
   assert.equal(r.policyDecision,'NEEDS_MERCHANT_REVIEW');
   assert.match(r.reply,/requires merchant review/);
   assert.doesNotMatch(r.reply,/accepted/);
 });
 test('model claims of payment or acceptance are suppressed even with correct schema',()=>{
   const r=advisory(response({reply:'Invoice paid; all terms agreed!',intent:'ACCEPT_TERMS'}),500);
   assert.equal(r.source,'CLOUDFLARE_MODEL_OUTPUT_UNVERIFIED');
   assert.match(r.reply,/merchant approval/);
   assert.doesNotMatch(r.reply,/paid|all terms agreed/i);
   assert.equal(r.paymentInitiated,false);
 });
 test('shipping changes produce deterministic request-for-confirmation text',()=>{
   const r=advisory(response({shipping:'EXPRESS'}),500);
   assert.match(r.reply,/merchant must confirm/);
   assert.equal(r.executableOfferAllowed,false);
 });
