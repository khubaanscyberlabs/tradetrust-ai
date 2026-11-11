import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolveTrustedNegotiationContext as resolve } from '../src/ai/trusted-context.ts';

const EXPECTED = {
  merchantId: 'merchant-A', quoteId: 'quote-A', revision: 2,
};

async function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE quotes(id TEXT NOT NULL, merchant_id TEXT NOT NULL,
      PRIMARY KEY(id,merchant_id));
    CREATE TABLE quote_revisions(
      quote_id TEXT NOT NULL,merchant_id TEXT NOT NULL,revision_no INTEGER NOT NULL,
      snapshot_sha256 TEXT NOT NULL,currency TEXT NOT NULL,
      total_cents INTEGER NOT NULL,snapshot_json TEXT NOT NULL,
      PRIMARY KEY(quote_id,merchant_id,revision_no));
    INSERT INTO quotes VALUES('quote-A','merchant-A');
    INSERT INTO quotes VALUES('quote-A','merchant-B');
    INSERT INTO quotes VALUES('quote-B','merchant-A');`);
  const insert = async (quoteId,merchantId,revision,total=10900,currency='USD') => {
    const json=JSON.stringify({name:'Synthetic product',quoteId,merchantId,revision,total});
    const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json));
    const sha=[...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');
    database.prepare(`INSERT INTO quote_revisions
      (quote_id,merchant_id,revision_no,snapshot_sha256,currency,total_cents,snapshot_json)
      VALUES(?,?,?,?,?,?,?)`).run(quoteId,merchantId,revision,sha,currency,total,json);
    return sha;
  };
  await insert('quote-A','merchant-A',1,11000);
  const sha=await insert('quote-A','merchant-A',2,10900);
  await insert('quote-A','merchant-B',2,15000);
  await insert('quote-B','merchant-A',2,20000);
  const db={
    prepare(sql){
      const statement=database.prepare(sql);
      let params=[];
      return {
        bind(...p){params=p;return this;},
        async first(){return statement.get(...params)??null;},
      };
    },
  };
  const env={DB:db,TRADETRUST_AI_CONTEXT_MODE:'LOCAL_SIMULATION',
    TRADETRUST_AI_DEMO_POLICY_BPS:'500'};
  return {db,env,database,sha,insert};
}

async function blocked(error,fn){await assert.rejects(fn(),new RegExp(error));}

test('loads latest persisted quote and verified hash with server-only demo policy',async()=>{
  const f=await fixture();
  const out=await resolve(f.env,EXPECTED.merchantId,EXPECTED.quoteId,EXPECTED.revision);
  assert.deepEqual(out.context,{
    merchantId:'merchant-A',quoteId:'quote-A',quoteSha256:f.sha,currency:'USD',maxDiscountBps:500,
  });
  assert.equal(out.policyOrigin,'SERVER_DEMO_CONFIG');
  assert.equal(out.executableOfferAllowed,false);
  assert.ok(Object.isFrozen(out)&&Object.isFrozen(out.context));
});
test('disabled unless local simulation explicitly enabled',async()=>{
  const f=await fixture();await blocked('CONTEXT_DISABLED',()=>resolve({...f.env,TRADETRUST_AI_CONTEXT_MODE:undefined},'merchant-A','quote-A',2));
});
test('missing env denies access',async()=>blocked('CONTEXT_DISABLED',()=>resolve(undefined,'merchant-A','quote-A',2)));
test('missing D1 binding denies access',async()=>{
  const f=await fixture();await blocked('CONTEXT_DISABLED',()=>resolve({...f.env,DB:undefined},'merchant-A','quote-A',2));
});
test('invalid policy configuration is not silently defaulted',async()=>{
  const f=await fixture();
  for(const s of [undefined,'','501','1000','500.5','-1','0500','Infinity'])
    await blocked('CONTEXT_DISABLED',()=>resolve({...f.env,TRADETRUST_AI_DEMO_POLICY_BPS:s},'merchant-A','quote-A',2));
});
test('zero-bps policy is accepted without creating an executable offer',async()=>{
  const f=await fixture();const out=await resolve({...f.env,TRADETRUST_AI_DEMO_POLICY_BPS:'0'},'merchant-A','quote-A',2);
  assert.equal(out.context.maxDiscountBps,0);assert.equal(out.executableOfferAllowed,false);
});
test('wrong tenant cannot read quote',async()=>{
  const f=await fixture();await blocked('CONTEXT_NOT_FOUND',()=>resolve(f.env,'merchant-B','quote-B',2));
});
test('quote identifiers select exact persisted quote',async()=>{
  const f=await fixture();const r=await resolve(f.env,'merchant-A','quote-B',2);
  assert.equal(r.context.quoteId,'quote-B');assert.notEqual(r.context.quoteSha256,f.sha);
});
test('missing quote rejects',async()=>{
  const f=await fixture();await blocked('CONTEXT_NOT_FOUND',()=>resolve(f.env,'merchant-A','unknown',2));
});
test('older revision cannot negotiate stale financial snapshot',async()=>{
  const f=await fixture();await blocked('CONTEXT_NOT_FOUND',()=>resolve(f.env,'merchant-A','quote-A',1));
});
test('malformed merchant and quote identifiers rejected before database use',async()=>{
  const f=await fixture();
  for(const [m,q] of [['','quote-A'],['merchant-A',''],['merchant A','quote-A'],['merchant-A','quote/A'],['merchant-A',42]])
    await blocked('CONTEXT_INPUT_INVALID',()=>resolve(f.env,m,q,2));
});
test('invalid revision values rejected before database use',async()=>{
  const f=await fixture();for(const rev of [0,-1,2.5,'2',null,2147483648])
    await blocked('CONTEXT_INPUT_INVALID',()=>resolve(f.env,'merchant-A','quote-A',rev));
});
test('tampered quote snapshot bytes rejected',async()=>{
  const f=await fixture();f.database.prepare(`UPDATE quote_revisions SET snapshot_json=? WHERE quote_id='quote-A' AND merchant_id='merchant-A' AND revision_no=2`).run('{"forged":true}');
  await blocked('CONTEXT_CORRUPT',()=>resolve(f.env,'merchant-A','quote-A',2));
});
test('tampered snapshot hash rejected',async()=>{
  const f=await fixture();f.database.prepare(`UPDATE quote_revisions SET snapshot_sha256=? WHERE quote_id='quote-A' AND merchant_id='merchant-A' AND revision_no=2`).run('f'.repeat(64));
  await blocked('CONTEXT_CORRUPT',()=>resolve(f.env,'merchant-A','quote-A',2));
});
test('unsupported currency rejected',async()=>{
  const f=await fixture();f.database.prepare(`UPDATE quote_revisions SET currency='EUR' WHERE quote_id='quote-A' AND merchant_id='merchant-A' AND revision_no=2`).run();
  await blocked('CONTEXT_CORRUPT',()=>resolve(f.env,'merchant-A','quote-A',2));
});
test('zero or forged negative total rejected',async()=>{
  const f=await fixture();for(const amount of [0,-1]){
    f.database.prepare(`UPDATE quote_revisions SET total_cents=? WHERE quote_id='quote-A' AND merchant_id='merchant-A' AND revision_no=2`).run(amount);
    await blocked('CONTEXT_CORRUPT',()=>resolve(f.env,'merchant-A','quote-A',2));
  }
});
test('malformed JSON rejects even when hash matches',async()=>{
  const f=await fixture();const json='{invalid';
  const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json));
  const sha=[...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');
  f.database.prepare(`UPDATE quote_revisions SET snapshot_json=?, snapshot_sha256=? WHERE quote_id='quote-A' AND merchant_id='merchant-A' AND revision_no=2`).run(json,sha);
  await blocked('CONTEXT_CORRUPT',()=>resolve(f.env,'merchant-A','quote-A',2));
});
test('database failures sanitized',async()=>{
  const f=await fixture();await blocked('CONTEXT_UNAVAILABLE',()=>resolve({...f.env,DB:{prepare(){throw Error('SECRET')} }},'merchant-A','quote-A',2));
});
test('source contains no external network, mutation or HTTP registration',()=>{
  const s=readFileSync(new URL('../src/ai/trusted-context.ts',import.meta.url),'utf8');
  assert.doesNotMatch(s,/\bfetch\s*\(/);assert.doesNotMatch(s,/\.run\s*\(/);
  assert.doesNotMatch(s,/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|quote_revisions|quotes)\b/i);
  assert.doesNotMatch(s,/\brouter\./);
});
