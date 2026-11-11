import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { simulateTrustedLocalNegotiation as run } from '../src/ai/trusted-negotiation-workflow.ts';

const SELECT = {merchantId:'merchant-A',quoteId:'quote-A',revisionNo:2};
const message = 'Can I have 4% off?';
const suggested=(extra={})=>({status:'completed',output:[{
  type:'message',role:'assistant',status:'completed',content:[{
    type:'output_text',text:JSON.stringify({reply:'I can relay that offer.',intent:'REQUEST_DISCOUNT',discount_bps:400,shipping:'UNCHANGED',...extra}),
  }],
}]});
function mock(extra={}, seen=()=>{}) {
  return async(url, init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(init.method,'POST');
    assert.equal(init.headers.Authorization,'Bearer test-only-not-a-real-key');
    const body=JSON.parse(init.body);
    assert.equal(body.input[0].content[0].text,message);
    assert.equal(body.store,false);
    seen();
    return Response.json(suggested(extra));
  };
}
async function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE quotes(id TEXT NOT NULL,merchant_id TEXT NOT NULL,PRIMARY KEY(id,merchant_id));
    CREATE TABLE quote_revisions(quote_id TEXT NOT NULL,merchant_id TEXT NOT NULL,revision_no INTEGER NOT NULL,
      snapshot_sha256 TEXT NOT NULL,currency TEXT NOT NULL,total_cents INTEGER NOT NULL,snapshot_json TEXT NOT NULL,
      PRIMARY KEY(quote_id,merchant_id,revision_no));
    INSERT INTO quotes VALUES('quote-A','merchant-A');`);
  const insert=async (rev,amount)=>{
    const json=JSON.stringify({quoteId:'quote-A',merchantId:'merchant-A',revision:rev,total:amount});
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json));
    const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    db.prepare('INSERT INTO quote_revisions VALUES(?,?,?,?,?,?,?)').run('quote-A','merchant-A',rev,hash,'USD',amount,json);
    return hash;
  };
  await insert(1,11000);const sha=await insert(2,10900);
  const readDb={prepare(sql){const stmt=db.prepare(sql);let p=[];return {bind(...values){p=values;return this;},async first(){return stmt.get(...p)??null;}};}};
  const env={DB:readDb, TRADETRUST_AI_CONTEXT_MODE:'LOCAL_SIMULATION',TRADETRUST_AI_DEMO_POLICY_BPS:'500',
    TRADETRUST_AI_WORKFLOW_MODE:'LOCAL_SIMULATION',TRADETRUST_AI_MODE:'MOCK_TRANSPORT',
    OPENAI_API_KEY:'test-only-not-a-real-key',OPENAI_MODEL:'test-model-v1'};
  return {db,env,sha};
}
async function reject(code, envChange={}, selection=SELECT, buyer=message, transport=mock()) {
  const {env}=await fixture();
  await assert.rejects(run({...env,...envChange},selection,buyer,transport), e=>e.message===code);
}
test('D1-backed current quote drives nonbinding mock $109 negotiation',async()=>{
  const f=await fixture();let calls=0;
  const r=await run(f.env,SELECT,message,mock({},()=>{calls++;}));
  assert.equal(calls,1);assert.equal(r.quoteSha256,f.sha);assert.equal(r.revisionNo,2);
  assert.equal(r.suggestion.discountBps,400);assert.equal(r.suggestion.policyDecision,'WITHIN_POLICY');
  assert.equal(r.suggestion.source,'MOCK_TRANSPORT');assert.equal(r.policyOrigin,'SERVER_DEMO_CONFIG');
  assert.equal(r.executableOfferAllowed,false);assert.equal(r.merchantApprovalRecorded,false);assert.equal(r.paymentInitiated,false);
  assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.suggestion));
});
test('request above 5% is flagged review not approved',async()=>{
  const f=await fixture();const r=await run(f.env,SELECT,message,mock({discount_bps:800}));
  assert.equal(r.suggestion.policyDecision,'NEEDS_MERCHANT_REVIEW');assert.equal(r.executableOfferAllowed,false);
});
test('zero policy disallows 4% automatically',async()=>{
  const f=await fixture();const r=await run({...f.env,TRADETRUST_AI_DEMO_POLICY_BPS:'0'},SELECT,message,mock());
  assert.equal(r.suggestion.policyDecision,'NEEDS_MERCHANT_REVIEW');
});
test('workflow disabled never touches DB or provider',async()=>{
  const f=await fixture();let touched=0;
  await assert.rejects(run({...f.env,TRADETRUST_AI_WORKFLOW_MODE:undefined,DB:{prepare(){touched++;throw Error('DB!');}}},SELECT,message,mock({},()=>touched++)),/WORKFLOW_DISABLED/);
  assert.equal(touched,0);
});
test('live mode forbidden before DB or API',async()=>reject('TRADETRUST_AI_WORKFLOW_DISABLED',{TRADETRUST_AI_MODE:'LIVE_TEST'}));
test('real API key forbidden before DB or API',async()=>reject('TRADETRUST_AI_WORKFLOW_DISABLED',{OPENAI_API_KEY:'sk-'+'a'.repeat(28)}));
test('real fetch transport forbidden before DB',async()=>reject('TRADETRUST_AI_WORKFLOW_DISABLED',{},SELECT,message,fetch));
test('missing injected transport forbidden',async()=>{
  const f=await fixture();await assert.rejects(run(f.env,SELECT,message,undefined),/WORKFLOW_DISABLED/);
});
test('hidden client total rejected before D1',async()=>reject('TRADETRUST_AI_WORKFLOW_SELECTION_INVALID',{}, {...SELECT,total_cents:1}));
test('prototype-polluted selection rejected',async()=>reject('TRADETRUST_AI_WORKFLOW_SELECTION_INVALID',{},Object.assign(Object.create({danger:true}),SELECT)));
test('cross-merchant quote is unavailable without provider call',async()=>{
  const f=await fixture();let calls=0;
  await assert.rejects(run(f.env,{...SELECT,merchantId:'merchant-B'},message,mock({},()=>calls++)),/CONTEXT_NOT_FOUND/);
  assert.equal(calls,0);
});
test('stale revision rejected before provider call',async()=>{
  const f=await fixture();let calls=0;
  await assert.rejects(run(f.env,{...SELECT,revisionNo:1},message,mock({},()=>calls++)),/CONTEXT_NOT_FOUND/);
  assert.equal(calls,0);
});
test('tampered D1 snapshot fails before mocked provider',async()=>{
  const f=await fixture();f.db.prepare("UPDATE quote_revisions SET snapshot_json='{}' WHERE revision_no=2").run();
  let calls=0;
  await assert.rejects(run(f.env,SELECT,message,mock({},()=>calls++)),/CONTEXT_CORRUPT/);
  assert.equal(calls,0);
});
test('AI forged financial total rejected before output',async()=>{
  const f=await fixture();await assert.rejects(run(f.env,SELECT,message,mock({total_cents:1})),/RESPONSE_INVALID/);
});
test('upstream failure sanitized',async()=>{
  const f=await fixture();await assert.rejects(run(f.env,SELECT,message,async()=>{throw Error('never-reveal');}),
    e=>e.message==='TRADETRUST_LIVE_AI_PROVIDER_UNAVAILABLE');
});
test('no fetch, D1 mutation or public HTTP in workflow source',()=>{
  const src=readFileSync(new URL('../src/ai/trusted-negotiation-workflow.ts',import.meta.url),'utf8');
  assert.doesNotMatch(src,/await\s+fetch\s*\(|\bDB\s*\.\s*prepare\s*\(|\.run\s*\(|router\.(post|get)\s*\(/);
});
