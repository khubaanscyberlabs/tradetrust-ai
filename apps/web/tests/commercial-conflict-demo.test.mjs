import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assessSyntheticBrowserTerms, previewBuyerPresets, previewSellerEvidence } from '../src/tradetrust/commercialConflictDemo.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function review(overrides = {}, seller = previewSellerEvidence) {
  return assessSyntheticBrowserTerms(seller, { ...previewBuyerPresets.disagreement, ...overrides });
}
test('sample merchant evidence is unambiguously synthetic', () => {
  assert.equal(previewSellerEvidence.evidence, 'SYNTHETIC_BROWSER_DATA_NOT_D1');
  assert.equal(previewSellerEvidence.shippingPayer, 'UNSPECIFIED');
  assert.equal(previewSellerEvidence.deliveryDeadline, null);
});
test('initial disagreement is blocked for over-limit discount', () => {
  const r = review(); assert.equal(r.status, 'BLOCKED_CONFLICT');
  assert(r.findings.some(x=>x.code==='DISCOUNT_OVER_DEMO_LIMIT'));
});
test('shipping responsibility is unresolved even if buyer thinks seller pays', () => {
  assert(review().findings.some(x=>x.code==='SHIPPING_UNRESOLVED'));
});
test('shipping charge does not establish that buyer pays', () => {
  assert(review({ shippingPayer:'BUYER_PAYS' }).findings.some(x=>x.code==='SHIPPING_UNRESOLVED'));
});
test('lack of buyer shipping opinion still unresolved', () => {
  assert(review({ shippingPayer:'UNSPECIFIED' }).findings.some(x=>x.code==='SHIPPING_UNRESOLVED'));
});
test('delivery request is flagged because merchant has not committed', () => {
  assert(review().findings.some(x=>x.code==='DELIVERY_UNCONFIRMED'));
});
test('no delivery request does not invent commitment', () => {
  assert(!review({requestedDeliveryDeadline:null}).findings.some(x=>x.code==='DELIVERY_UNCONFIRMED'));
});
test('currency mismatch is a material conflict', () => {
  assert(review({currency:'EUR'}).findings.some(x=>x.code==='CURRENCY_CONFLICT' && x.severity==='CONFLICT'));
});
test('quantity mismatch is a material conflict', () => {
  assert(review({quantity:3}).findings.some(x=>x.code==='QUANTITY_CONFLICT'));
});
test('subtotal mismatch is a material conflict', () => {
  assert(review({assumedSubtotalCents:18000}).findings.some(x=>x.code==='SUBTOTAL_CONFLICT'));
});
test('discount at exactly 5% is not over ceiling', () => {
  assert(!review({requestedDiscountBps:500}).findings.some(x=>x.code==='DISCOUNT_OVER_DEMO_LIMIT'));
});
test('lower discount and no conflicting terms still requires shipping clarification', () => {
  const r=review(previewBuyerPresets.clarification);
  assert.equal(r.status,'NEEDS_CLARIFICATION');
  assert.deepEqual(r.findings.map(x=>x.code),['SHIPPING_UNRESOLVED']);
});
test('matching numbers are not evidence of approval', () => {
  const r=review(previewBuyerPresets.clarification);
  assert.equal(r.humanApprovalRecorded,false); assert.equal(r.evidenceVerifiedByD1,false);
});
test('every scenario prohibits approval invoice and payment', () => {
  for (const preset of Object.values(previewBuyerPresets)) {
    const r=review(preset);
    assert.equal(r.canApprove,false);assert.equal(r.canInvoice,false);assert.equal(r.canPay,false);
  }
});
test('unsafe amount is rejected', () => {
  assert.throws(()=>review({assumedSubtotalCents:Number.MAX_SAFE_INTEGER}),/PREVIEW_BUYER_INVALID/);
});
test('fractional quantities rejected', () => {
  assert.throws(()=>review({quantity:2.25}),/PREVIEW_BUYER_INVALID/);
});
test('invalid currency rejected', () => {
  assert.throws(()=>review({currency:'JPY'}),/PREVIEW_BUYER_INVALID/);
});
test('out-of-range discount rejected', () => {
  assert.throws(()=>review({requestedDiscountBps:10001}),/PREVIEW_BUYER_INVALID/);
});
test('invalid date rejected', () => {
  assert.throws(()=>review({requestedDeliveryDeadline:'2026-11-31'}),/PREVIEW_BUYER_INVALID/);
});
test('seller cannot be spoofed as D1 verified', () => {
  assert.throws(()=>review({}, {...previewSellerEvidence, evidence:'VERIFIED_LATEST_D1_QUOTE_REVISION'}), /PREVIEW_SELLER_UNTRUSTED/);
});
test('seller cannot invent shipping responsibility', () => {
  assert.throws(()=>review({}, {...previewSellerEvidence, shippingPayer:'SELLER_PAYS'}), /PREVIEW_SELLER_UNTRUSTED/);
});
test('browser module contains no fetch or storage or financial side effects', () => {
  const s=readFileSync(resolve(root,'src/tradetrust/commercialConflictDemo.ts'),'utf8');
  assert(!/\bfetch\s*\(|localStorage|sessionStorage|\.run\s*\(|\.prepare\s*\(/.test(s));
});
test('UI makes provenance and payment limitations explicit', () => {
  const s=readFileSync(resolve(root,'src/tradetrust/CommercialConflictReview.tsx'),'utf8');
  for (const marker of ['SYNTHETIC · NO D1 CONNECTION','Merchant approval unavailable','PayPal invoice unavailable','Payment unavailable','No action on this screen records agreement']) {
    assert(s.includes(marker),marker);
  }
  assert(!/\bfetch\s*\(|localStorage|sessionStorage|dangerouslySetInnerHTML/.test(s));
});
test('main app includes interactive review without changing existing payment stage', () => {
  const s=readFileSync(resolve(root,'src/tradetrust/TradeTrustDemo.tsx'),'utf8');
  assert(s.includes('<CommercialConflictReview />'));
  assert(s.includes('Pay with PayPal — unavailable'));
});
