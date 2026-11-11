import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessCommercialTerms as assess } from '../src/ai/commercial-terms-integrity.ts';
const id = {merchantId:'merchant-A',quoteId:'quote-1',revisionNo:2,quoteSha256:'a'.repeat(64)};
const seller = {currency:'USD',quantity:200,quotedSubtotalCents:200000,shippingPayer:'BUYER_PAYS',knownShippingCents:25000,deliveryDeadline:null,maxDiscountBps:500};
const buyer = {currency:'USD',quantity:200,assumedSubtotalCents:200000,shippingPayer:'BUYER_PAYS',requestedDeliveryDeadline:null,requestedDiscountBps:0};
const f=(s={},b={},i={})=>assess({...id,...i},{...seller,...s},{...buyer,...b});
const codes=(r)=>r.findings.map(x=>x.code);
const bad=(cb,code)=>assert.throws(cb,e=>e.message===code);
test('aligned explicit terms remain unverified and nonbinding',()=>{
 const r=f();assert.equal(r.status,'ALIGNED_UNVERIFIED');assert.deepEqual(r.findings,[]);
 assert.equal(r.executableOfferAllowed,false);assert.equal(r.agreementVerified,false);
 assert.equal(r.merchantApprovalRecorded,false);assert.equal(r.paymentInitiated,false);
 assert.equal(r.mode,'OFFLINE_STRUCTURED_COMPARISON');assert.equal(r.quoteSha256,id.quoteSha256);
 assert.ok(Object.isFrozen(r));assert.ok(Object.isFrozen(r.findings));
});
test('buyer assumes free shipping while merchant says buyer pays',()=>{
 const r=f({},{shippingPayer:'SELLER_PAYS'});assert.equal(r.status,'BLOCKED_CONFLICT');
 assert.deepEqual(codes(r),['SHIPPING_PAYER_CONFLICT']);
 assert.equal(r.findings[0].illustrativeShippingExposureCents,25000);
 assert.ok(Object.isFrozen(r.findings[0]));
});
test('unknown shipping charge has no invented financial exposure',()=>{
 const r=f({knownShippingCents:null},{shippingPayer:'SELLER_PAYS'});
 assert.equal(r.findings[0].illustrativeShippingExposureCents,null);
});
test('buyer and seller currency mismatch is blocked, no FX math',()=>{
 const r=f({},{currency:'AED'});assert.deepEqual(codes(r),['CURRENCY_CONFLICT']);
 assert.equal(r.currency,'USD');
});
test('quantity mismatch blocked',()=>assert.ok(codes(f({},{quantity:199})).includes('QUANTITY_CONFLICT')));
test('assumed subtotal mismatch blocked',()=>assert.ok(codes(f({},{assumedSubtotalCents:199999})).includes('SUBTOTAL_CONFLICT')));
test('discount over 5 percent triggers merchant review, not approval',()=>{
 const r=f({},{requestedDiscountBps:800});assert.deepEqual(codes(r),['DISCOUNT_OVER_DEMO_LIMIT']);
 assert.equal(r.status,'BLOCKED_CONFLICT'); assert.equal(r.merchantApprovalRecorded,false);
});
test('exact ceiling remains advisory only',()=>{
 const r=f({},{requestedDiscountBps:500});assert.equal(r.status,'ALIGNED_UNVERIFIED');
 assert.equal(r.executableOfferAllowed,false);
});
test('buyer requests deadline seller never approved',()=>{
 const r=f({},{requestedDeliveryDeadline:'2026-11-20'});
 assert.equal(r.status,'NEEDS_CLARIFICATION'); assert.deepEqual(codes(r),['DELIVERY_UNCONFIRMED']);
});
test('buyer requests different date than seller commitment',()=>{
 const r=f({deliveryDeadline:'2026-11-22'},{requestedDeliveryDeadline:'2026-11-20'});
 assert.deepEqual(codes(r),['DELIVERY_DEADLINE_CONFLICT']);assert.equal(r.status,'BLOCKED_CONFLICT');
});
test('buyer has not confirmed seller delivery date',()=>{
 assert.equal(f({deliveryDeadline:'2026-11-22'}).status,'NEEDS_CLARIFICATION');
});
test('matching explicitly declared delivery date is not blocked',()=>{
 assert.equal(f({deliveryDeadline:'2026-11-22'},{requestedDeliveryDeadline:'2026-11-22'}).status,'ALIGNED_UNVERIFIED');
});
test('unknown buyer shipping status requires clarification',()=>{
 assert.deepEqual(codes(f({},{shippingPayer:null})),['SHIPPING_UNRESOLVED']);
});
test('unspecified seller shipping responsibility requires clarification',()=>{
 assert.deepEqual(codes(f({shippingPayer:'UNSPECIFIED'})),['SHIPPING_UNRESOLVED']);
});
test('missing buyer amount/currency/quantity/discount requires clarification',()=>{
 const r=f({},{currency:null,quantity:null,assumedSubtotalCents:null,requestedDiscountBps:null});
 assert.equal(r.status,'NEEDS_CLARIFICATION');assert.ok(codes(r).includes('BUYER_TERMS_INCOMPLETE'));
});
test('multiple material conflicts appear independently without hiding findings',()=>{
 const r=f({deliveryDeadline:'2026-11-25'},{currency:'EUR',quantity:100,assumedSubtotalCents:500,
  shippingPayer:'SELLER_PAYS',requestedDeliveryDeadline:'2026-11-20',requestedDiscountBps:800});
 assert.deepEqual(codes(r),['CURRENCY_CONFLICT','QUANTITY_CONFLICT','SUBTOTAL_CONFLICT',
  'SHIPPING_PAYER_CONFLICT','DELIVERY_DEADLINE_CONFLICT','DISCOUNT_OVER_DEMO_LIMIT']);
 assert.equal(r.status,'BLOCKED_CONFLICT');
});
test('unsupported merchant currency rejects input',()=>bad(()=>f({currency:'EUR'}),'TRADETRUST_TERMS_SELLER_REJECTED'));
test('noninteger subtotal is rejected, never rounded',()=>bad(()=>f({quotedSubtotalCents:123.4}),'TRADETRUST_TERMS_SELLER_REJECTED'));
test('negative discount rejected',()=>bad(()=>f({},{requestedDiscountBps:-1}),'TRADETRUST_TERMS_BUYER_REJECTED'));
test('discount above 100 percent rejected',()=>bad(()=>f({},{requestedDiscountBps:10001}),'TRADETRUST_TERMS_BUYER_REJECTED'));
test('demo ceiling above 5 percent rejected',()=>bad(()=>f({maxDiscountBps:501}),'TRADETRUST_TERMS_SELLER_REJECTED'));
test('invalid calendar date rejected',()=>bad(()=>f({},{requestedDeliveryDeadline:'2026-02-30'}),'TRADETRUST_TERMS_BUYER_REJECTED'));
test('valid leap date accepted',()=>{
 const r=f({deliveryDeadline:'2028-02-29'},{requestedDeliveryDeadline:'2028-02-29'});
 assert.equal(r.status,'ALIGNED_UNVERIFIED');
});
test('invalid quote hash rejected',()=>bad(()=>f({}, {},{quoteSha256:'b'}),'TRADETRUST_TERMS_IDENTITY_REJECTED'));
test('additional buyer financial authority key rejected',()=>{
 bad(()=>assess(id,seller,{...buyer,approved:true}),'TRADETRUST_TERMS_BUYER_REJECTED');
});
test('inherited prototype rejected',()=>{
 const injected=Object.assign(Object.create({canPay:true}),buyer);
 bad(()=>assess(id,seller,injected),'TRADETRUST_TERMS_BUYER_REJECTED');
});
test('getter-based injected object rejected without access',()=>{
 let count=0;
 const b={...buyer};
 Object.defineProperty(b,'currency',{enumerable:true,get(){count++;return 'USD';}});
 bad(()=>assess(id,seller,b),'TRADETRUST_TERMS_BUYER_REJECTED'); assert.equal(count,0);
});
test('untrusted buyer cannot invent sub-cent currency or runaway size',()=>{
 bad(()=>f({},{currency:'USD\n'}),'TRADETRUST_TERMS_BUYER_REJECTED');
 bad(()=>f({},{assumedSubtotalCents:100000001}),'TRADETRUST_TERMS_BUYER_REJECTED');
});
test('no network, AI, financial, D1, or side-effect calls in pure module',()=>{
 const src=readFileSync(new URL('../src/ai/commercial-terms-integrity.ts',import.meta.url),'utf8');
 assert.doesNotMatch(src,/\bfetch\s*\(|\bAI\.run\s*\(|\bprepare\s*\(|\bwriteFile\s*\(/);
});
