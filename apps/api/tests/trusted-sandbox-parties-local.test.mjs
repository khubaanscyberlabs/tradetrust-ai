import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalSandboxParties } from '../src/paypal/trusted-sandbox-parties-local.ts';

const original = () => ({
  approval_id: 'approval-x', merchant_id: 'merchant-x', quote_id: 'quote-x',
  revision_no: 1, snapshot_sha256: 'a'.repeat(64),
  invoicer_email: 'seller@example.test', buyer_email: 'buyer@example.test',
  invoicer_business_name: 'Example Seller', origin: 'LOCAL_OPERATOR_REGISTERED',
  actor_id: 'actor-x', role: 'OWNER',
});
const auth = () => ({ actorId: 'actor-x', merchantId: 'merchant-x', role: 'OWNER' });
function db(row = original()) {
  return {prepare(sql) {
    assert.match(sql, /JOIN approvals a/);
    assert.match(sql, /JOIN quote_revisions r/);
    assert.match(sql, /JOIN merchant_memberships mm/);
    assert.match(sql, /JOIN merchant_actors ma/);
    assert.match(sql, /mm\.status = 'ACTIVE'/);
    assert.match(sql, /ma\.status = 'ACTIVE'/);
    assert.match(sql, /MAX\(z\.revision_no\)/);
    assert.match(sql, /mm\.role IN \('OWNER','MANAGER'\)/);
    return {bind(...values) {
      assert.deepEqual(values, ['actor-x','merchant-x','approval-x']);
      return {async first() { return row; }};
    }};
  }};
}
const call = (row=original(), actor=auth(), approval='approval-x') =>
  resolveLocalSandboxParties(db(row), actor, approval);

test('valid operator-registered record returns non-authorizing evidence', async () => {
  const result = await call();
  assert.equal(result.parties.source, 'TRUSTED_SERVER_RECORD');
  assert.equal(result.paypalIdentityVerified, false);
  assert.equal(result.paymentAuthorized, false);
  assert.equal(result.sourceAssurance, 'LOCAL_D1_OPERATOR_REGISTERED_NOT_PROVIDER_VERIFIED');
  assert.equal(Object.keys(result.parties).length, 5);
  assert.ok(Object.isFrozen(result.parties));
});
test('manager can read scoped record', async () => {
  const row=original();row.role='MANAGER';
  const actor=auth();actor.role='MANAGER';
  assert.equal((await call(row,actor)).quoteId,'quote-x');
});
test('missing row rejected', async ()=>assert.rejects(call(null)));
test('missing DB rejected', async ()=>assert.rejects(resolveLocalSandboxParties(null,auth(),'approval-x')));
test('STAFF rejected', async ()=>assert.rejects(call(original(),{...auth(),role:'STAFF'})));
test('bad authenticated actor ID rejected', async ()=>assert.rejects(call(original(),{...auth(),actorId:'oops!'})));
test('bad merchant ID rejected', async ()=>assert.rejects(call(original(),{...auth(),merchantId:'bad/merchant'})));
test('bad approval ID rejected', async ()=>assert.rejects(call(original(),auth(),'bad/approval')));
test('wrong actor returned rejected', async ()=>assert.rejects(call({...original(),actor_id:'someone-else'})));
test('wrong merchant returned rejected', async ()=>assert.rejects(call({...original(),merchant_id:'merchant-y'})));
test('wrong approval returned rejected', async ()=>assert.rejects(call({...original(),approval_id:'approval-y'})));
test('wrong role returned rejected', async ()=>assert.rejects(call({...original(),role:'STAFF'})));
test('wrong origin returned rejected', async ()=>assert.rejects(call({...original(),origin:'IMPERSONATED'})));
test('invalid quote ID rejected', async ()=>assert.rejects(call({...original(),quote_id:'?'})));
test('invalid revision rejected', async ()=>assert.rejects(call({...original(),revision_no:0})));
test('mismatched snapshot format rejected', async ()=>assert.rejects(call({...original(),snapshot_sha256:'z'.repeat(64)})));
test('invalid seller email rejected', async ()=>assert.rejects(call({...original(),invoicer_email:'bad@example..test'})));
test('invalid buyer email rejected', async ()=>assert.rejects(call({...original(),buyer_email:'hello\n@example.test'})));
test('same sender and recipient rejected', async ()=>assert.rejects(call({...original(),buyer_email:'SELLER@example.test'})));
test('blank business name rejected', async ()=>assert.rejects(call({...original(),invoicer_business_name:'  '})));
test('control character in business name rejected', async ()=>assert.rejects(call({...original(),invoicer_business_name:'Seller\nBad'})));
test('D1 query failure fails closed', async ()=>assert.rejects(resolveLocalSandboxParties({prepare(){throw Error('offline');}},auth(),'approval-x'), /UNAVAILABLE/));
