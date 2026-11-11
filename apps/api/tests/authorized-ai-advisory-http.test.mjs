import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/index.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const PATH = '/api/merchant/ai-advisory';
const DATA = JSON.stringify({buyerMessage:'Please clarify shipping responsibility and delivery date.'});

function request(method='POST', origin=ORIGIN, body=DATA, extra={}) {
  return new Request(ORIGIN + PATH, {
    method, headers:{Origin:origin,'Content-Type':'application/json',...extra},
    ...(method === 'POST' ? {body} : {}),
  });
}
function env(overrides={}) {
  let queries = 0;
  let inferences = 0;
  return {
    state: () => ({queries,inferences}),
    config: {
      TRADETRUST_AUTH_MODE:'LOCAL_SESSION',
      TRADETRUST_LOCAL_LOGIN_SHA256:'a'.repeat(64),
      TRADETRUST_LOCAL_SUBJECT:'local-demo-owner',
      TRADETRUST_AI_CONTEXT_MODE:'LOCAL_SIMULATION',
      TRADETRUST_AI_DEMO_POLICY_BPS:'500',
      TRADETRUST_CF_AI_WORKFLOW_MODE:'LOCAL_EXPLICIT_TEST_ONLY',
      TRADETRUST_CF_AI_EXECUTION_MODE:'LOCAL_EXPLICIT_TEST_ONLY',
      TRADETRUST_CF_AI_HTTP_MODE:'LOCAL_AUTHENTICATED_ONESHOT',
      DB:{prepare(){queries++;throw Error('DB MUST NOT BE ACCESSED');}},
      AI:{async run(){inferences++;throw Error('AI MUST NOT BE CALLED');}},
      ...overrides,
    },
  };
}

test('AI advisory stays hidden with missing explicit execution gates',async()=>{
  const x=env({TRADETRUST_CF_AI_WORKFLOW_MODE:undefined});
  const r=await handleRequest(request(),x.config);
  assert.equal(r.status,404); assert.deepEqual(x.state(),{queries:0,inferences:0});
});
test('AI advisory stays hidden without explicit HTTP enablement',async()=>{
  const x=env({TRADETRUST_CF_AI_HTTP_MODE:undefined});
  const r=await handleRequest(request(),x.config);
  assert.equal(r.status,404); assert.deepEqual(x.state(),{queries:0,inferences:0});
});
test('AI advisory stays hidden when the real binding is absent',async()=>{
  const x=env({AI:undefined});
  const r=await handleRequest(request(),x.config);
  assert.equal(r.status,404); assert.deepEqual(x.state(),{queries:0,inferences:0});
});
test('wrong HTTP method cannot perform an inference',async()=>{
  const x=env(); const r=await handleRequest(request('GET'),x.config);
  assert.equal(r.status,405); assert.deepEqual(x.state(),{queries:0,inferences:0});
});
test('cross-origin POST denied before D1 or AI access',async()=>{
  const x=env(); const r=await handleRequest(request('POST','http://127.0.0.1:5173'),x.config);
  assert.equal(r.status,403); assert.deepEqual(x.state(),{queries:0,inferences:0});
});
test('unauthenticated local POST denied before D1 or AI access',async()=>{
  const x=env(); const r=await handleRequest(request(),x.config);
  assert.equal(r.status,403); assert.deepEqual(x.state(),{queries:0,inferences:0});
});
test('bearer or Access assertion cannot bypass local authentication',async()=>{
  const x=env(); const r=await handleRequest(request('POST',ORIGIN,DATA,{
    Authorization:'Bearer forged'}),x.config);
  assert.equal(r.status,403); assert.deepEqual(x.state(),{queries:0,inferences:0});
});
test('missing AI preview context gate hides execution endpoint',async()=>{
  const x=env({TRADETRUST_AI_CONTEXT_MODE:undefined});
  const r=await handleRequest(request(),x.config);
  assert.equal(r.status,404); assert.deepEqual(x.state(),{queries:0,inferences:0});
});
