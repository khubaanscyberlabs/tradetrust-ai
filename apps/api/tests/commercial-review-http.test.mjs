import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { commercialReviewHttpEndpoint } from '../src/commercial-review-http.ts';
import { handleRequest } from '../src/index.ts';

const ORIGIN = 'https://merchant.example.test';
const TEAM = 'https://demo.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const M = 'merchant-A';
const Q = 'quote-A';
const buyer = () => ({
  currency:'USD', quantity:2, assumedSubtotalCents:8400,
  shippingPayer:'SELLER_PAYS', requestedDeliveryDeadline:'2026-11-20',
  requestedDiscountBps:800,
});
const input = () => ({merchantId:M,quoteId:Q,revisionNo:1,buyer:buyer()});
const keys = (async()=>{
  const pair=await generateKeyPair('RS256',{extractable:true});
  const jwk=await exportJWK(pair.publicKey);
  return {privateKey:pair.privateKey,resolver:createLocalJWKSet({keys:[{...jwk,kid:'review-test-key',alg:'RS256',use:'sig'}]})};
})();
async function token(subject='human-owner') {
  const {privateKey}=await keys;
  const now=Math.floor(Date.now()/1000);
  return new SignJWT({iss:TEAM,aud:[AUD],sub:subject,type:'app',email:'test@example.test',iat:now,nbf:now-5,exp:now+1800})
    .setProtectedHeader({alg:'RS256',kid:'review-test-key'}).sign(privateKey);
}
function fixture(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for (const name of ['0001_dealroom_foundation.sql','0002_approval_integrity.sql','0003_merchant_authorization.sql','0004_approval_idempotency.sql','0005_paypal_draft_operations.sql']) {
    raw.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  }
  raw.prepare('INSERT INTO merchants(id,display_name) VALUES(?,?)').run(M,'Synthetic A');
  raw.prepare('INSERT INTO merchants(id,display_name) VALUES(?,?)').run('merchant-B','Synthetic B');
  raw.prepare('INSERT INTO dealrooms(id,merchant_id) VALUES(?,?)').run('room-A',M);
  raw.prepare('INSERT INTO dealrooms(id,merchant_id) VALUES(?,?)').run('room-B','merchant-B');
  raw.prepare('INSERT INTO quotes(id,merchant_id,dealroom_id) VALUES(?,?,?)').run(Q,M,'room-A');
  raw.prepare('INSERT INTO quotes(id,merchant_id,dealroom_id) VALUES(?,?,?)').run('quote-B','merchant-B','room-B');
  const quote={
    currency:'USD',status:'PROPOSAL_REQUIRES_MERCHANT_APPROVAL',
    lines:[{sku:'OUTFIT-01',name:'Embroidered Outfit',quantity:2,unitCents:4200,lineCents:8400}],
    discountBps:200,subtotalCents:8400,discountCents:168,shippingCents:2500,totalCents:10732,
  };
  const snapshot=JSON.stringify(quote);
  const hash=createHash('sha256').update(snapshot).digest('hex');
  const statement=raw.prepare(`INSERT INTO quote_revisions (
    quote_id,merchant_id,revision_no,currency,subtotal_cents,discount_cents,
    shipping_cents,total_cents,snapshot_json,snapshot_sha256)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  statement.run(Q,M,1,'USD',8400,168,2500,10732,snapshot,hash);
  statement.run('quote-B','merchant-B',1,'USD',8400,168,2500,10732,snapshot,hash);
  for(const [id,subject,role,status] of [
    ['actor-owner','human-owner','OWNER','ACTIVE'],
    ['actor-manager','human-manager','MANAGER','ACTIVE'],
    ['actor-staff','human-staff','STAFF','ACTIVE'],
    ['actor-revoked','human-revoked','OWNER','REVOKED'],
  ]){
    raw.prepare('INSERT INTO merchant_actors(id,provider,issuer,subject) VALUES(?,?,?,?)')
      .run(id,'CLOUDFLARE_ACCESS',TEAM,subject);
    raw.prepare('INSERT INTO merchant_memberships(merchant_id,actor_id,role,status) VALUES(?,?,?,?)')
      .run(M,id,role,status);
  }
  const statements=[];
  const DB={prepare(sql){
    statements.push(sql);
    return {bind(...args){return {async first(){return raw.prepare(sql).get(...args)??null;}}}};
  }};
  const env={
    DB, ACCESS_TEAM_DOMAIN:TEAM,ACCESS_AUD:AUD,
    TRADETRUST_TERMS_HTTP_MODE:'enabled',
    TRADETRUST_TERMS_ALLOWED_ORIGIN:ORIGIN,
    TRADETRUST_TERMS_REVIEW_MODE:'LOCAL_SIMULATION',
    TRADETRUST_AI_CONTEXT_MODE:'LOCAL_SIMULATION',
    TRADETRUST_AI_DEMO_POLICY_BPS:'500',
  };
  return {raw,DB,env,statements,hash};
}
function req(body=input(),jwt=null,overrides={}) {
  return new Request(`${overrides.requestOrigin??ORIGIN}/api/merchant/terms-review`, {
    method:overrides.method??'POST',
    headers:{
      Origin:overrides.origin??ORIGIN,
      'Content-Type':overrides.contentType??'application/json',
      ...(jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}),
    },
    ...(overrides.method==='GET'?{}:{body:typeof body==='string'?body:JSON.stringify(body)}),
  });
}
async function invoke(r,env){const {resolver}=await keys;return commercialReviewHttpEndpoint(r,env,x=>x.text(),resolver)}

// All tests operate on in-memory SQLite and synthetic, locally signed JWTs.
test('authorized owner gets D1-bound, nonbinding findings',async()=>{
  const f=fixture();const r=await invoke(req(input(),await token()),f.env);
  assert.equal(r.status,200);const obj=await r.json();
  assert.equal(obj.review.mode,'LOCAL_TRUSTED_D1_READ_ONLY');
  assert.equal(obj.review.quoteSha256,f.hash);
  assert.equal(obj.review.sellerEvidence.quantity,2);
  assert.equal(obj.review.sellerEvidence.shippingResponsibilityVerified,false);
  assert.equal(obj.review.sellerEvidence.deliveryCommitmentVerified,false);
  assert.equal(obj.review.assessment.status,'BLOCKED_CONFLICT');
  assert(obj.review.assessment.findings.some(x=>x.code==='SHIPPING_UNRESOLVED'));
  assert(obj.review.assessment.findings.some(x=>x.code==='DISCOUNT_OVER_DEMO_LIMIT'));
  assert.equal(obj.review.paymentInitiated,false);
  assert.equal(obj.review.merchantApprovalRecorded,false);
  assert.equal(obj.review.executableOfferAllowed,false);
  assert(f.statements.every(x=>/^\s*SELECT\b/i.test(x)));
  assert.equal(r.headers.get('Cache-Control'),'no-store');
  f.raw.close();
});
test('authorized manager can review without approval transition',async()=>{
  const f=fixture();const r=await invoke(req(input(),await token('human-manager')),f.env);
  assert.equal(r.status,200);assert.equal((await r.json()).review.merchantApprovalRecorded,false);f.raw.close();
});
test('STAFF cannot reuse OWNER/MANAGER review permission',async()=>{
  const f=fixture();const r=await invoke(req(input(),await token('human-staff')),f.env);
  assert.equal(r.status,403);assert.equal(f.statements.length,1);f.raw.close();
});
test('revoked merchant membership fails closed',async()=>{
  const f=fixture();const r=await invoke(req(input(),await token('human-revoked')),f.env);
  assert.equal(r.status,403);assert.equal(f.statements.length,1);f.raw.close();
});
test('missing signed identity cannot query quotation data',async()=>{
  const f=fixture();const r=await invoke(req(),f.env);
  assert.equal(r.status,403);assert.equal(f.statements.length,0);f.raw.close();
});
test('cross-tenant quote cannot be read even with authorized merchant membership',async()=>{
  const f=fixture();const r=await invoke(req({...input(),quoteId:'quote-B'},await token()),f.env);
  assert.equal(r.status,503);assert.equal((await r.json()).error,'review_unavailable');f.raw.close();
});
test('client cannot impersonate another tenant',async()=>{
  const f=fixture();const r=await invoke(req({...input(),merchantId:'merchant-B'},await token()),f.env);
  assert.equal(r.status,403);assert.equal(f.statements.length,1);f.raw.close();
});
test('stale quote revision fails closed',async()=>{
  const f=fixture();const r=await invoke(req({...input(),revisionNo:2},await token()),f.env);
  assert.equal(r.status,503);f.raw.close();
});
test('malformed buyer values get 422 with no provider operations',async()=>{
  const f=fixture();const r=await invoke(req({...input(),buyer:{...buyer(),requestedDiscountBps:99999}},await token()),f.env);
  assert.equal(r.status,422);assert.equal((await r.json()).error,'invalid_buyer_terms');f.raw.close();
});
test('unknown selector fields are rejected before database access',async()=>{
  const f=fixture();const r=await invoke(req({...input(),admin:true},await token()),f.env);
  assert.equal(r.status,400);assert.equal(f.statements.length,0);f.raw.close();
});
test('missing mode flag returns 404 before D1 access',async()=>{
  const f=fixture();const env={...f.env,TRADETRUST_TERMS_HTTP_MODE:undefined};
  const r=await invoke(req(input(),await token()),env);
  assert.equal(r.status,404);assert.equal(f.statements.length,0);f.raw.close();
});
test('wrong Origin rejected without D1 access',async()=>{
  const f=fixture();const r=await invoke(req(input(),await token(),{origin:'https://evil.example.test'}),f.env);
  assert.equal(r.status,403);assert.equal(f.statements.length,0);f.raw.close();
});
test('request URL origin mismatch returns 404',async()=>{
  const f=fixture();const r=await invoke(req(input(),await token(),{requestOrigin:'https://evil.example.test'}),f.env);
  assert.equal(r.status,404);assert.equal(f.statements.length,0);f.raw.close();
});
test('missing configured origin returns 404',async()=>{
  const f=fixture();const r=await invoke(req(input(),await token()),{...f.env,TRADETRUST_TERMS_ALLOWED_ORIGIN:undefined});
  assert.equal(r.status,404);assert.equal(f.statements.length,0);f.raw.close();
});
test('non-JSON Content-Type rejected',async()=>{
  const f=fixture();const r=await invoke(req(input(),await token(),{contentType:'text/plain'}),f.env);
  assert.equal(r.status,415);assert.equal(f.statements.length,0);f.raw.close();
});
test('invalid HTTP method rejected',async()=>{
  const f=fixture();const r=await invoke(req(input(),await token(),{method:'GET'}),f.env);
  assert.equal(r.status,405);assert.equal(f.statements.length,0);f.raw.close();
});
test('tampered D1 snapshot hash is not accepted',async()=>{
  const f=fixture();
  assert.throws(()=>f.raw.prepare('UPDATE quote_revisions SET snapshot_sha256=? WHERE quote_id=?').run('f'.repeat(64),Q),/append-only/);
  const r=await invoke(req(input(),await token()),f.env);
  assert.equal(r.status,200); // immutable stored snapshot still verified
  f.raw.close();
});
test('router defaults to 404 when review mode not enabled',async()=>{
  const f=fixture();const res=await handleRequest(req(input(),await token()),{...f.env,TRADETRUST_TERMS_HTTP_MODE:undefined});
  assert.equal(res.status,404);f.raw.close();
});
