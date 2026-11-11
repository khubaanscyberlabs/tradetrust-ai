import test from 'node:test';
import assert from 'node:assert/strict';

import {
  permitsPayPalDraftCreateScope,
} from '../src/paypal/sandbox-create-draft.ts';

const GENERAL =
  'https://uri.paypal.com/services/invoicing';

const WRITE =
  'https://uri.paypal.com/services/invoicing/invoices/readwrite';

const READ =
  'https://uri.paypal.com/services/invoicing/invoices/read';

test('accepts the general Invoicing grant observed in Sandbox', () => {
  assert.equal(permitsPayPalDraftCreateScope(GENERAL), true);
});

test('continues accepting explicit invoice readwrite grant', () => {
  assert.equal(permitsPayPalDraftCreateScope(WRITE), true);
});

test('rejects narrow read-only grant', () => {
  assert.equal(permitsPayPalDraftCreateScope(READ), false);
});

test('rejects substring matches and forged scope suffixes', () => {
  assert.equal(
    permitsPayPalDraftCreateScope(GENERAL + '/untrusted'),
    false
  );
  assert.equal(
    permitsPayPalDraftCreateScope('forged:' + GENERAL),
    false
  );
});

test('rejects missing and malformed scope values', () => {
  for (const value of [undefined, null, '', {}, [], 42]) {
    assert.equal(permitsPayPalDraftCreateScope(value), false);
  }
});

test('accepts legitimate grant within a scope list', () => {
  assert.equal(
    permitsPayPalDraftCreateScope('openid ' + GENERAL),
    true
  );
});
