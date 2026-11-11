import test, {mock} from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN='http://127.0.0.1:8787';
const QUOTE='21c50c14-fe6b-4c5f-9811-aee5306aa38c';
const HASH='225b8ff7fb7f90ca06c80ce809409ee5d524590ce506b189c566c24bddbd5235';
const MERCHANT='merchant-local-demo';
const MODEL='@cf/google/gemma-4-26b-a4b-it';
const previewUrl=new URL('../src/ai/authorized-ai-context-preview-http.ts', import.meta.url);
const trustedUrl=new URL('../src/ai/trusted-context.ts',import.meta.url);
let previewCalls=0;
let previewMode="valid";
let trustedCalls=0;
const success={mode:'LOCAL_APPROVED_AI_CONTEXT_PREVIEW',merchantId:MERCHANT,quoteId:QUOTE,revisionNo:1,quoteSha256:HASH,currency:'USD',totalCents:10900,model:MODEL,policyOrigin:'SERVER_DEMO_CONFIG',maxDemoDiscountBps:500,approvedQuoteVerified:true,contextPrepared:true,actualModelInference:false,providerCallAttempted:false,executableOfferAllowed:false,merchantApprovalRecorded:false,paymentInitiated:false};
mock.module(previewUrl.href, {namedExports:{authorizedAiContextPreviewHttp: async () => {
  previewCalls++;
  const record = previewMode === "tampered" ? {...success,quoteSha256:"f".repeat(64)} : success;
  return new Response(JSON.stringify(record),{status:200,headers:{'Content-Type':'application/json'}});
}}});
mock.module(trustedUrl.href, {namedExports:{resolveTrustedNegotiationContext: async (_,merchant,quote,revision) => {
  trustedCalls++;
  assert.equal(merchant,MERCHANT);assert.equal(quote,QUOTE);assert.equal(revision,1);
  return {context:{merchantId:MERCHANT,quoteId:QUOTE,quoteSha256:HASH,currency:'USD',maxDiscountBps:500},revisionNo:1,policyOrigin:'SERVER_DEMO_CONFIG',executableOfferAllowed:false};
}}});
let caseId=0;
const load=async()=> (await import('../src/ai/authorized-ai-advisory-http.ts?positive-mock-case='+(++caseId))).authorizedAiAdvisoryHttp;
function env(aiRun){return {
  TRADETRUST_AUTH_MODE:'LOCAL_SESSION', TRADETRUST_LOCAL_LOGIN_SHA256:'a'.repeat(64), TRADETRUST_LOCAL_SUBJECT:'fixture-owner',
  TRADETRUST_AI_CONTEXT_MODE:'LOCAL_SIMULATION',TRADETRUST_AI_DEMO_POLICY_BPS:'500',
  TRADETRUST_CF_AI_WORKFLOW_MODE:'LOCAL_EXPLICIT_TEST_ONLY',TRADETRUST_CF_AI_EXECUTION_MODE:'LOCAL_EXPLICIT_TEST_ONLY',
  TRADETRUST_CF_AI_HTTP_MODE:'LOCAL_AUTHENTICATED_ONESHOT',
  DB:{prepare(){throw Error('Unexpected real D1 access in mocked test');}},
  AI:{run:aiRun}
};}
function req(){return new Request(ORIGIN+'/api/merchant/ai-advisory',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json','Cookie':'fixture-session=dummy'},body:JSON.stringify({buyerMessage:'Please clarify who pays shipping and the delivery date.'})});}
const read = (r) => r.text();

test('mocked-positive: actual HTTP handler -> trusted bridge -> one fake AI binding invocation -> nonbinding response and duplicate rejection',async()=>{
  const handler=await load();
  let calls=0;
  const binding=env(async(model,input,opts)=>{
    calls++;
    assert.equal(model,MODEL);
    assert.equal(opts.rejectIfBusy,true);
    assert.ok(input);
    return {response:'not JSON so the real adapter must fail closed'};
  });
  const r=await handler(req(),binding,read);
  assert.equal(r.status,200);
  const obj=await r.json();
  assert.equal(obj.mode,'LOCAL_AUTHENTICATED_NONBINDING_AI_ADVISORY');
  assert.equal(obj.totalCents,10900);
  assert.equal(obj.quoteSha256,HASH);
  assert.equal(obj.providerCallAttempted,true);
  assert.equal(obj.oneAttemptConsumed,true);
  assert.equal(obj.executableOfferAllowed,false);
  assert.equal(obj.merchantApprovalRecorded,false);
  assert.equal(obj.paymentInitiated,false);
  assert.equal(obj.advisory.nonBinding,true);
  assert.equal(obj.advisory.executableOfferAllowed,false);
  assert.equal(obj.advisory.paymentInitiated,false);
  assert.equal(calls,1);
  const repeat=await handler(req(),binding,read);
  assert.equal(repeat.status,409);
  assert.equal(calls,1);
});

test('mocked-positive: network exception produces safe clarification without retry and consumes attempt',async()=>{
  const handler=await load();let calls=0;
  const binding=env(async()=>{calls++;throw Error('private provider fault');});
  const response=await handler(req(),binding,read);
  assert.equal(response.status,200);
  const obj=await response.json();
  assert.equal(obj.advisory.nonBinding,true);
  assert.equal(obj.advisory.paymentInitiated,false);
  assert.equal(obj.paymentInitiated,false);
  assert.equal(obj.providerCallAttempted,true);
  assert.equal(calls,1);
  assert.equal((await handler(req(),binding,read)).status,409);
  assert.equal(calls,1);
});

test('mocked-positive: forged preview hash is denied before provider and does not consume the attempt',async()=>{
  const handler=await load(); let calls=0;
  const binding=env(async()=>{calls++;return {response:'malformed'};});
  previewMode='tampered';
  const denied=await handler(req(),binding,read);
  assert.equal(denied.status,503);
  assert.equal(calls,0);
  previewMode='valid';
  const allowed=await handler(req(),binding,read);
  assert.equal(allowed.status,200);
  assert.equal(calls,1);
});

test('mocked-positive: preview and trusted context were invoked (test substitutes, not real D1)',()=>{
  assert.equal(previewCalls,6);
  assert.equal(trustedCalls,3);
});
