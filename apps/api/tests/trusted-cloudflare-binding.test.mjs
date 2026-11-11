import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { previewTrustedCloudflareViaBinding as run } from '../src/ai/trusted-cloudflare-binding.ts';

const selected = {merchantId:'merchant-A',quoteId:'quote-A',revisionNo:2};
const snapshot = JSON.stringify({lines:[{sku:'item-1',quantity:1,unit_price_cents:10900}],shipping:'STANDARD',total_cents:10900});
const digest = createHash('sha256').update(snapshot).digest('hex');
const row = {quote_id:'quote-A',merchant_id:'merchant-A',revision_no:2,snapshot_sha256:digest,currency:'USD',total_cents:10900,snapshot_json:snapshot};
const completion = (extra={})=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({reply:'Review requested.',intent:'REQUEST_DISCOUNT',discount_bps:400,shipping:'UNCHANGED',...extra})}}]});
function fakeDb(value=row){return {prepare(sql){assert.match(sql,/LIMIT 1/);return {bind(m,q,r){return {async first(){return m==='merchant-A'&&q==='quote-A'&&r===2?value:null;}}}}}}}
function fixture(opts={}) {
  const calls=[];
  const e = {
    TRADETRUST_CF_AI_WORKFLOW_MODE:'LOCAL_EXPLICIT_TEST_ONLY',
    TRADETRUST_CF_AI_EXECUTION_MODE:'LOCAL_EXPLICIT_TEST_ONLY',
    TRADETRUST_AI_CONTEXT_MODE:'LOCAL_SIMULATION',
    TRADETRUST_AI_DEMO_POLICY_BPS:'500',
    DB:fakeDb(),
    AI:{async run(...args){calls.push(args); return completion();}},
    ...opts,
  };
  return {e,calls};
}
const reject = async (fn,code)=>assert.rejects(fn,x=>x instanceof Error && x.message===code);

test('trusted quote invokes fake binding once; never approves finance',async()=>{
  const {e,calls}=fixture(); const r=await run(e,selected,'Can I have 4 percent off?');
  assert.equal(calls.length,1);assert.equal(calls[0][0],'@cf/google/gemma-4-26b-a4b-it');
  assert.equal(calls[0][2].rejectIfBusy,true);
  assert.equal(calls[0][1].stream,false);
  assert.equal(r.mode,'INTERNAL_LOCAL_BINDING');assert.equal(r.quoteSha256,digest);
  assert.equal(r.advisory.discountBps,400);assert.equal(r.advisory.policyDecision,'WITHIN_POLICY');
  assert.equal(r.providerCallAttempted,true);assert.equal(r.executableOfferAllowed,false);
  assert.equal(r.merchantApprovalRecorded,false);assert.equal(r.paymentInitiated,false);
  assert.equal(r.advisory.nonBinding,true);assert.ok(Object.isFrozen(r));
});
test('8% cannot evade merchant 5% ceiling',async()=>{
  const {e}=fixture({AI:{async run(){return completion({discount_bps:800})}}});
  const r=await run(e,selected,'I demand 8 percent.');
  assert.equal(r.advisory.policyDecision,'NEEDS_MERCHANT_REVIEW');assert.match(r.advisory.reply,/merchant review/);
});
test('shipping change never becomes approved commitment',async()=>{
  const {e}=fixture({AI:{async run(){return completion({shipping:'EXPRESS'})}}});
  const r=await run(e,selected,'Please change shipping to express.');
  assert.match(r.advisory.reply,/merchant must confirm/);assert.equal(r.executableOfferAllowed,false);
});
test('malformed model output returns fixed clarification',async()=>{
  const {e}=fixture({AI:{async run(){return {response:'Sure, 8 percent and free shipping approved.'}}}});
  const r=await run(e,selected,'Please make it free shipping.');
  assert.equal(r.advisory.source,'LOCAL_SAFE_FALLBACK');assert.equal(r.advisory.discountBps,0);
  assert.equal(r.paymentInitiated,false);
});
test('provider error returns safe clarification with no retries',async()=>{
  let calls=0;
  const {e}=fixture({AI:{async run(){calls++;throw new Error('injected provider error')}}});
  const r=await run(e,selected,'Can I have a discount?');
  assert.equal(calls,1);assert.equal(r.advisory.source,'LOCAL_SAFE_FALLBACK');
});
test('missing gate denies before database read or AI',async()=>{
  let touches=0;const {e}=fixture({TRADETRUST_CF_AI_EXECUTION_MODE:undefined,DB:{prepare(){touches++}},AI:{run(){touches++}}});
  await reject(()=>run(e,selected,'Can I have 4% off?'),'TRADETRUST_CF_BINDING_DISABLED');assert.equal(touches,0);
});
test('production-like gate denies',async()=>{
  const {e,calls}=fixture({TRADETRUST_CF_AI_WORKFLOW_MODE:'PRODUCTION'});
  await reject(()=>run(e,selected,'Can I have 4% off?'),'TRADETRUST_CF_BINDING_DISABLED');assert.equal(calls.length,0);
});
test('missing AI binding denies before D1',async()=>{
  let reads=0;const {e}=fixture({AI:undefined,DB:{prepare(){reads++}}});
  await reject(()=>run(e,selected,'Can I have 4% off?'),'TRADETRUST_CF_BINDING_DISABLED');assert.equal(reads,0);
});
test('cross-tenant selection does not reach provider',async()=>{
  const {e,calls}=fixture();await reject(()=>run(e,{...selected,merchantId:'merchant-B'},'Please discount.'),'TRADETRUST_AI_CONTEXT_NOT_FOUND');assert.equal(calls.length,0);
});
test('stale revision does not reach provider',async()=>{
  const {e,calls}=fixture();await reject(()=>run(e,{...selected,revisionNo:1},'Please discount.'),'TRADETRUST_AI_CONTEXT_NOT_FOUND');assert.equal(calls.length,0);
});
test('client-injected financial amount in selector denies before D1',async()=>{
  let reads=0;const {e}=fixture({DB:{prepare(){reads++}}});
  await reject(()=>run(e,{...selected,total_cents:1},'Please discount.'),'TRADETRUST_CF_BINDING_SELECTION_REJECTED');assert.equal(reads,0);
});
test('prototype-polluted selector denies before D1',async()=>{
  const {e,calls}=fixture();await reject(()=>run(e,Object.assign(Object.create({bad:true}),selected),'Please discount.'),'TRADETRUST_CF_BINDING_SELECTION_REJECTED');assert.equal(calls.length,0);
});
test('tampered stored quote hash denies before AI',async()=>{
  const {e,calls}=fixture({DB:fakeDb({...row,snapshot_sha256:'b'.repeat(64)})});
  await reject(()=>run(e,selected,'Please discount.'),'TRADETRUST_AI_CONTEXT_CORRUPT');assert.equal(calls.length,0);
});
test('unsupported currency denies before AI',async()=>{
  const {e,calls}=fixture({DB:fakeDb({...row,currency:'INR'})});
  await reject(()=>run(e,selected,'Please discount.'),'TRADETRUST_AI_CONTEXT_CORRUPT');assert.equal(calls.length,0);
});
test('invalid server policy denies before AI',async()=>{
  const {e,calls}=fixture({TRADETRUST_AI_DEMO_POLICY_BPS:'600'});
  await reject(()=>run(e,selected,'Please discount.'),'TRADETRUST_AI_CONTEXT_DISABLED');assert.equal(calls.length,0);
});
test('buyer text control characters deny before AI',async()=>{
  const {e,calls}=fixture();await reject(()=>run(e,selected,'Hello\nworld'),'TRADETRUST_CF_AI_BUYER_MESSAGE_REJECTED');assert.equal(calls.length,0);
});
test('forged model total cannot enter financial state',async()=>{
  const {e}=fixture({AI:{async run(){return completion({total_cents:1})}}});
  const r=await run(e,selected,'Please invoice one dollar');assert.equal(r.advisory.source,'LOCAL_SAFE_FALLBACK');assert.equal(r.paymentInitiated,false);
});
test('source does not create route, PayPal calls, DB writes, HTTP requests or retries',()=>{
  const src=readFileSync(new URL('../src/ai/trusted-cloudflare-binding.ts',import.meta.url),'utf8');
  assert.doesNotMatch(src,/\bfetch\s*\(|\bINSERT\b|\bUPDATE\b|\bDELETE\b|router\.(get|post)\s*\(|paypal\.com|wrangler\s+deploy/i);
  assert.equal((src.match(/await env\.AI\.run\(/g)||[]).length,1);
});
