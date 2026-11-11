import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestNegotiationProvider } from '../src/ai/live-provider.ts';

const ctx = Object.freeze({merchantId:'merchantA',quoteId:'quoteA',quoteSha256:'a'.repeat(64),currency:'USD',maxDiscountBps:500});
const env = Object.freeze({TRADETRUST_AI_MODE:'MOCK_TRANSPORT',OPENAI_MODEL:'test-model-v1',OPENAI_API_KEY:'test-only-not-a-real-key'});
const responseData = (change={})=>({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({reply:'I can pass this request to the merchant.',intent:'REQUEST_DISCOUNT',discount_bps:400,shipping:'UNCHANGED',...change})}]}]});
const provider = (change={})=>async (url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');
  assert.equal(options.method,'POST');
  assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Bearer test-only-not-a-real-key');
  const body=JSON.parse(options.body);
  assert.equal(body.store,false);
  assert.equal(body.tool_choice,'none');
  assert.equal(body.max_output_tokens,250);
  assert.equal(body.text.format.type,'json_schema');
  assert.equal(body.text.format.strict,true);
  assert.deepEqual(body.input[0].content[0].text,'Can I have 4% off?');
  return Response.json(responseData(change));
};
const msg='Can I have 4% off?';
async function denied(name, code, args){
  await test(name,async()=>{
    await assert.rejects(requestNegotiationProvider(...args),e=>e.message===code);
  });
}

test('accepted mock provider is explicitly labeled, nonbinding, 400 bps',async()=>{
  const res=await requestNegotiationProvider(env,ctx,msg,provider());
  assert.equal(res.source,'MOCK_TRANSPORT');
  assert.equal(res.discountBps,400);
  assert.equal(res.policyDecision,'WITHIN_POLICY');
  assert.equal(res.nonBinding,true);
  assert.ok(Object.isFrozen(res));
});
test('8 percent request cannot escape policy: review only',async()=>{
  const result=await requestNegotiationProvider(env,ctx,msg,provider({discount_bps:800}));
  assert.equal(result.policyDecision,'NEEDS_MERCHANT_REVIEW');
});
await denied('no env denies before transport','TRADETRUST_LIVE_AI_DENIED',[undefined,ctx,msg,provider()]);
await denied('no transport denies before network','TRADETRUST_LIVE_AI_DENIED',[env,ctx,msg]);
await denied('global fetch denied without explicit live authorization','TRADETRUST_LIVE_AI_DENIED',[env,ctx,msg,fetch]);
await denied('wrong mock mode denied','TRADETRUST_LIVE_AI_DENIED',[{...env,TRADETRUST_AI_MODE:'LIVE_TEST'},ctx,msg,provider()]);
await denied('live-approved flag cannot enter synthetic transport','TRADETRUST_LIVE_AI_DENIED',[{...env,TRADETRUST_AI_REAL_CALL_APPROVED:'YES_EXPLICITLY'},ctx,msg,provider()]);
await denied('real token cannot enter mock mode','TRADETRUST_LIVE_AI_DENIED',[{...env,OPENAI_API_KEY:'sk-'+'x'.repeat(30)},ctx,msg,provider()]);
await denied('client financial total injected into context','TRADETRUST_LIVE_AI_CONTEXT_INVALID',[env,{...ctx,total_cents:1},msg,provider()]);
await denied('policy exceeds supported range','TRADETRUST_LIVE_AI_CONTEXT_INVALID',[env,{...ctx,maxDiscountBps:20000},msg,provider()]);
await denied('buyer message too long','TRADETRUST_LIVE_AI_MESSAGE_INVALID',[env,ctx,'x'.repeat(1001),provider()]);
await denied('model produces forged total field','TRADETRUST_LIVE_AI_RESPONSE_INVALID',[env,ctx,msg,provider({total_cents:1})]);
await denied('model produces negative discount','TRADETRUST_LIVE_AI_RESPONSE_INVALID',[env,ctx,msg,provider({discount_bps:-1})]);
await denied('model produces fractional discount','TRADETRUST_LIVE_AI_RESPONSE_INVALID',[env,ctx,msg,provider({discount_bps:20.5})]);
await denied('model produces unknown intent','TRADETRUST_LIVE_AI_RESPONSE_INVALID',[env,ctx,msg,provider({intent:'APPROVE_PAYMENT'})]);
test('failed provider HTTP response is sanitized',async()=>{
  await assert.rejects(requestNegotiationProvider(env,ctx,msg,async()=>new Response('SECRET_UPSTREAM',{status:429})),e=>e.message==='TRADETRUST_LIVE_AI_PROVIDER_UNAVAILABLE'&&!e.message.includes('SECRET'));
});
test('timeout/transport error sanitized',async()=>{
  await assert.rejects(requestNegotiationProvider(env,ctx,msg,async()=>{throw Error('PRIVATE_KEY_HIDDEN')}),e=>e.message==='TRADETRUST_LIVE_AI_PROVIDER_UNAVAILABLE');
});
test('truncated/incomplete provider rejected',async()=>{
  await assert.rejects(requestNegotiationProvider(env,ctx,msg,async()=>Response.json({...responseData(),status:'incomplete'})),e=>e.message==='TRADETRUST_LIVE_AI_RESPONSE_INVALID');
});
test('large JSON provider payload rejected',async()=>{
  await assert.rejects(requestNegotiationProvider(env,ctx,msg,async()=>new Response('x'.repeat(32001),{status:200})),e=>e.message==='TRADETRUST_LIVE_AI_RESPONSE_INVALID');
});
test('source has no global fetch or D1 or public routes',()=>{
  const src=readFileSync(new URL('../src/ai/live-provider.ts',import.meta.url),'utf8');
  assert.ok(!src.includes('await fetch('));
  assert.ok(!src.includes('globalThis.fetch('));
  assert.ok(!src.includes('DB.prepare('));
  assert.ok(!src.includes('router.post('));
});
