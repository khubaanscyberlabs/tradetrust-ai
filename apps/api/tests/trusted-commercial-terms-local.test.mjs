import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assessTrustedCommercialTermsLocal } from '../src/ai/trusted-commercial-terms-local.ts';

const selection = Object.freeze({ merchantId: 'merchant-local-demo', quoteId: 'quote-01', revisionNo: 1 });
const buyer = Object.freeze({
  currency: 'USD', quantity: 2, assumedSubtotalCents: 8400,
  shippingPayer: 'SELLER_PAYS', requestedDeliveryDeadline: '2026-11-20',
  requestedDiscountBps: 800,
});
const baseQuote = () => ({
  currency: 'USD', status: 'PROPOSAL_REQUIRES_MERCHANT_APPROVAL',
  lines: [{ sku: 'OUTFIT-01', name: 'Embroidered Outfit', quantity: 2,
    unitCents: 4200, lineCents: 8400 }],
  discountBps: 200, subtotalCents: 8400, discountCents: 168,
  shippingCents: 2500, totalCents: 10732,
});
function rowFrom(snapshot = baseQuote()) {
  const snapshot_json = JSON.stringify(snapshot);
  const snapshot_sha256 = createHash('sha256').update(snapshot_json).digest('hex');
  return {
    merchant_id: selection.merchantId, quote_id: selection.quoteId,
    revision_no: 1, snapshot_sha256, snapshot_json,
    currency: 'USD', subtotal_cents: snapshot.subtotalCents,
    discount_cents: snapshot.discountCents,
    shipping_cents: snapshot.shippingCents, total_cents: snapshot.totalCents,
  };
}
function fake(row = rowFrom(), opts = {}) {
  const log = [];
  const env = {
    TRADETRUST_TERMS_REVIEW_MODE: 'LOCAL_SIMULATION',
    TRADETRUST_AI_CONTEXT_MODE: 'LOCAL_SIMULATION',
    TRADETRUST_AI_DEMO_POLICY_BPS: '500',
    DB: {
      prepare(sql) {
        if (!/^\s*SELECT\s/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|PRAGMA)\b/i.test(sql)) {
          throw Error('NOT_READ_ONLY');
        }
        return {
          bind(...values) {
            const no = log.length + 1;
            log.push({ sql, values });
            return {
              async first() {
                if (opts.throwOn === no) throw Error('D1_DOWN');
                const r = no === 2 ? (opts.secondRow ?? row) : row;
                if (no === 2 && (opts.missingSecond || !r)) return null;
                if (no === 1 && opts.missingFirst) return null;
                // For 09E1 the implementation requires two distinct SELECTs.
                assert.equal(values.length, no === 1 ? 3 : 4);
                return r;
              },
            };
          },
        };
      },
    },
  };
  return { env, log };
}
async function call(row = rowFrom(), b = buyer, opts) {
  const f = fake(row, opts);
  const result = await assessTrustedCommercialTermsLocal(f.env, selection, b);
  return { result, log: f.log };
}
const rejected = /TRADETRUST_(TRUSTED_TERMS|AI_CONTEXT|TERMS)_/;

// Integration happy path, strictly nonbinding.
test('verified latest quote is used, and no financial execution occurs', async () => {
  const { result, log } = await call();
  assert.equal(log.length, 2);
  assert.deepEqual(log[0].values, [selection.merchantId, selection.quoteId, 1]);
  assert.deepEqual(log[1].values, [selection.merchantId, selection.quoteId, 1, result.quoteSha256]);
  assert.equal(result.mode, 'LOCAL_TRUSTED_D1_READ_ONLY');
  assert.equal(result.sellerEvidence.sellerTermsOrigin, 'VERIFIED_LATEST_D1_QUOTE_REVISION');
  assert.equal(result.sellerEvidence.quantity, 2);
  assert.equal(result.sellerEvidence.quotedSubtotalCents, 8400);
  assert.equal(result.sellerEvidence.quotedShippingChargeCents, 2500);
  assert.equal(result.executableOfferAllowed, false);
  assert.equal(result.merchantApprovalRecorded, false);
  assert.equal(result.paymentInitiated, false);
  assert.equal(result.assessment.agreementVerified, false);
  assert.equal(result.assessment.status, 'BLOCKED_CONFLICT');
  assert(result.assessment.findings.some(f => f.code === 'DISCOUNT_OVER_DEMO_LIMIT'));
  assert(result.assessment.findings.some(f => f.code === 'DELIVERY_UNCONFIRMED'));
  assert(result.assessment.findings.some(f => f.code === 'SHIPPING_UNRESOLVED'));
  assert(!result.assessment.findings.some(f => f.code === 'SHIPPING_PAYER_CONFLICT'));
});

test('shipping charge never establishes the party liable to pay', async () => {
  const {result} = await call();
  assert.equal(result.sellerEvidence.shippingResponsibilityVerified, false);
  assert.equal(result.sellerEvidence.deliveryCommitmentVerified, false);
  assert.equal(result.assessment.findings.find(f=>f.code==='SHIPPING_UNRESOLVED').illustrativeShippingExposureCents, null);
});
test('matching assumptions still require shipping clarification and are not consent', async () => {
  const b = {...buyer, requestedDiscountBps:200, requestedDeliveryDeadline:null, shippingPayer:'BUYER_PAYS'};
  const {result} = await call(rowFrom(), b);
  assert.equal(result.assessment.status,'NEEDS_CLARIFICATION');
  assert.equal(result.assessment.nonBinding,true);
});
test('quantity mismatch comes from authoritative D1 lines, not buyer request', async () => {
  const {result} = await call(rowFrom(), {...buyer, quantity:3});
  assert(result.assessment.findings.some(f=>f.code==='QUANTITY_CONFLICT'));
});
test('currency mismatch blocks even when the quote is USD', async () => {
  const {result} = await call(rowFrom(), {...buyer, currency:'INR'});
  assert(result.assessment.findings.some(f=>f.code==='CURRENCY_CONFLICT'));
});
test('missing terms remain unresolved, never become consent', async () => {
  const {result} = await call(rowFrom(), {currency:null,quantity:null,assumedSubtotalCents:null,shippingPayer:null,requestedDeliveryDeadline:null,requestedDiscountBps:null});
  assert.equal(result.assessment.status,'NEEDS_CLARIFICATION');
  assert(result.assessment.findings.some(f=>f.code==='BUYER_TERMS_INCOMPLETE'));
});

test('execution mode must be explicitly local before D1 read', async()=>{
  const f=fake();delete f.env.TRADETRUST_TERMS_REVIEW_MODE;
  await assert.rejects(assessTrustedCommercialTermsLocal(f.env,selection,buyer),rejected);
  assert.equal(f.log.length,0);
});
test('missing trusted server policy rejects before D1 read',async()=>{
  const f=fake(); delete f.env.TRADETRUST_AI_DEMO_POLICY_BPS;
  await assert.rejects(assessTrustedCommercialTermsLocal(f.env,selection,buyer),rejected);
  assert.equal(f.log.length,0);
});
test('server policy above 500 rejects',async()=>{
  const f=fake(); f.env.TRADETRUST_AI_DEMO_POLICY_BPS='800';
  await assert.rejects(assessTrustedCommercialTermsLocal(f.env,selection,buyer),rejected);
});
test('extra untrusted merchant selector field rejects before query',async()=>{
  const f=fake();
  await assert.rejects(assessTrustedCommercialTermsLocal(f.env,{...selection,admin:true},buyer),rejected);
  assert.equal(f.log.length,0);
});
test('stale selection cannot bypass latest revision selector',async()=>{
  const f=fake();
  await assert.rejects(assessTrustedCommercialTermsLocal(f.env,{...selection,revisionNo:2},buyer),rejected);
});
test('different tenant row rejects',async()=>{
  await assert.rejects(call({...rowFrom(), merchant_id:'merchant-other'}),rejected);
});
test('missing first D1 row rejects',async()=>{
  await assert.rejects(call(rowFrom(),buyer,{missingFirst:true}),rejected);
});
test('missing pinned second D1 row rejects',async()=>{
  await assert.rejects(call(rowFrom(),buyer,{missingSecond:true}),rejected);
});
test('race to newer quotation/hash rejects',async()=>{
  const newRow=rowFrom();newRow.snapshot_sha256='c'.repeat(64);
  await assert.rejects(call(rowFrom(),buyer,{secondRow:newRow}),rejected);
});
test('tampered stored hash rejects',async()=>{
  await assert.rejects(call({...rowFrom(),snapshot_sha256:'a'.repeat(64)}),rejected);
});
test('D1 SELECT exception fails closed',async()=>{
  await assert.rejects(call(rowFrom(),buyer,{throwOn:2}),rejected);
});
test('snapshot subtotals must match trusted D1 columns',async()=>{
  await assert.rejects(call({...rowFrom(), subtotal_cents:1234}),rejected);
});
test('snapshot line amount cannot be manipulated even with valid sha',async()=>{
  const v=baseQuote();v.lines[0].lineCents=7000;
  await assert.rejects(call(rowFrom(v)),rejected);
});
test('snapshot discount cannot be manipulated even with valid sha',async()=>{
  const v=baseQuote();v.discountCents=170;v.totalCents=10730;
  await assert.rejects(call(rowFrom(v)),rejected);
});
test('snapshot total cannot be manipulated even with valid sha',async()=>{
  const v=baseQuote();v.totalCents=999;
  await assert.rejects(call(rowFrom(v)),rejected);
});
test('snapshot unexpected fields rejected',async()=>{
  const v=baseQuote();v.shippingPayer='SELLER_PAYS';
  await assert.rejects(call(rowFrom(v)),rejected);
});
test('snapshot shipping payer cannot be inferred from existing method/charge',async()=>{
  const v=baseQuote();v.shippingCents=6500;v.totalCents=14732;
  const {result}=await call(rowFrom(v));
  assert.equal(result.sellerEvidence.shippingResponsibilityVerified,false);
  assert(result.assessment.findings.some(f=>f.code==='SHIPPING_UNRESOLVED'));
});
test('malformed buyer assumptions are rejected',async()=>{
  await assert.rejects(call(rowFrom(),{...buyer, requestedDiscountBps:12000}),rejected);
});
test('prototype attack on selector rejected before query',async()=>{
  const f=fake();
  const malicious=Object.assign(Object.create({privileged:true}),selection);
  await assert.rejects(assessTrustedCommercialTermsLocal(f.env,malicious,buyer),rejected);
  assert.equal(f.log.length,0);
});
test('no private provider/PayPal/AI binding required',async()=>{
  const f=fake();
  const r=await assessTrustedCommercialTermsLocal(f.env,selection,buyer);
  assert.equal(r.paymentInitiated,false);
  assert.equal(Object.keys(f.env).some(k=>/paypal|api_key|secret|ai_binding/i.test(k)),false);
});
