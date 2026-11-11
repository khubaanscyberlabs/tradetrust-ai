/**
 * TradeTrust 09B-03-12-09E2 — synthetic browser-only commercial review.
 * Not the D1-backed authoritative implementation. Do NOT use this output to
 * authorize, price, approve, invoice, pay, or sign a commercial agreement.
 * Future server responses require authentication and verified provenance.
 */
export type PreviewBuyerTerms = Readonly<{
  currency: 'USD' | 'EUR';
  quantity: number;
  assumedSubtotalCents: number;
  shippingPayer: 'BUYER_PAYS' | 'SELLER_PAYS' | 'UNSPECIFIED';
  requestedDeliveryDeadline: string | null;
  requestedDiscountBps: number;
}>;
export type PreviewSellerEvidence = Readonly<{
  currency: 'USD';
  quantity: number;
  subtotalCents: number;
  quotedShippingChargeCents: number;
  maxDemoDiscountBps: number;
  shippingPayer: 'UNSPECIFIED';
  deliveryDeadline: null;
  evidence: 'SYNTHETIC_BROWSER_DATA_NOT_D1';
}>;
export type PreviewFinding = Readonly<{
  code: string;
  severity: 'CONFLICT' | 'REVIEW' | 'CLARIFICATION';
  title: string;
  detail: string;
}>;
export type PreviewAssessment = Readonly<{
  mode: 'BROWSER_SYNTHETIC_ILLUSTRATION';
  status: 'BLOCKED_CONFLICT' | 'NEEDS_CLARIFICATION';
  findings: readonly PreviewFinding[];
  canApprove: false;
  canInvoice: false;
  canPay: false;
  humanApprovalRecorded: false;
  evidenceVerifiedByD1: false;
}>;

export const previewSellerEvidence: PreviewSellerEvidence = Object.freeze({
  currency: 'USD', quantity: 2, subtotalCents: 19800,
  quotedShippingChargeCents: 1000, maxDemoDiscountBps: 500,
  shippingPayer: 'UNSPECIFIED', deliveryDeadline: null,
  evidence: 'SYNTHETIC_BROWSER_DATA_NOT_D1',
});

export const previewBuyerPresets = Object.freeze({
  disagreement: Object.freeze({ currency: 'USD', quantity: 2,
    assumedSubtotalCents: 19800, shippingPayer: 'SELLER_PAYS',
    requestedDeliveryDeadline: '2026-11-20', requestedDiscountBps: 800,
  }) satisfies PreviewBuyerTerms,
  clarification: Object.freeze({ currency: 'USD', quantity: 2,
    assumedSubtotalCents: 19800, shippingPayer: 'BUYER_PAYS',
    requestedDeliveryDeadline: null, requestedDiscountBps: 400,
  }) satisfies PreviewBuyerTerms,
  mismatch: Object.freeze({ currency: 'EUR', quantity: 3,
    assumedSubtotalCents: 18000, shippingPayer: 'SELLER_PAYS',
    requestedDeliveryDeadline: '2026-11-20', requestedDiscountBps: 800,
  }) satisfies PreviewBuyerTerms,
});

function guardWhole(n: unknown, max: number): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;
}
function validateSeller(value: PreviewSellerEvidence): void {
  if (value?.evidence !== 'SYNTHETIC_BROWSER_DATA_NOT_D1' ||
      value.currency !== 'USD' || value.shippingPayer !== 'UNSPECIFIED' ||
      value.deliveryDeadline !== null || !guardWhole(value.quantity, 1000000) ||
      value.quantity === 0 || !guardWhole(value.subtotalCents, 100000000) ||
      value.subtotalCents === 0 ||
      !guardWhole(value.quotedShippingChargeCents, 100000000) ||
      !guardWhole(value.maxDemoDiscountBps, 500)) {
    throw Error('PREVIEW_SELLER_UNTRUSTED');
  }
}
function validateBuyer(value: PreviewBuyerTerms): void {
  if (!value || (value.currency !== 'USD' && value.currency !== 'EUR') ||
      !guardWhole(value.quantity, 1000000) || value.quantity === 0 ||
      !guardWhole(value.assumedSubtotalCents, 100000000) ||
      !['BUYER_PAYS','SELLER_PAYS','UNSPECIFIED'].includes(value.shippingPayer) ||
      !guardWhole(value.requestedDiscountBps, 10000) ||
      (value.requestedDeliveryDeadline !== null &&
       (typeof value.requestedDeliveryDeadline !== 'string' ||
        !/^2026-11-(?:0[1-9]|[12][0-9]|30)$/.test(value.requestedDeliveryDeadline)))) {
    throw Error('PREVIEW_BUYER_INVALID');
  }
}
export function assessSyntheticBrowserTerms(
  seller: PreviewSellerEvidence, buyer: PreviewBuyerTerms,
): PreviewAssessment {
  validateSeller(seller);
  validateBuyer(buyer);
  const findings: PreviewFinding[] = [];
  function add(code: string, severity: PreviewFinding['severity'], title: string, detail: string): void {
    findings.push(Object.freeze({ code, severity, title, detail }));
  }
  if (buyer.currency !== seller.currency) {
    add('CURRENCY_CONFLICT','CONFLICT','Currency mismatch',
      'Seller quotes in USD while buyer assumes EUR. No currency conversion is agreed.');
  }
  if (buyer.quantity !== seller.quantity) {
    add('QUANTITY_CONFLICT','CONFLICT','Quantity mismatch',
      'Buyer assumes a different quantity than the seller quotation.');
  }
  if (buyer.assumedSubtotalCents !== seller.subtotalCents) {
    add('SUBTOTAL_CONFLICT','CONFLICT','Subtotal mismatch',
      'The buyer assumed a different goods subtotal. No revised total is authorized.');
  }
  // A quote showing a shipping charge does not establish legal responsibility.
  add('SHIPPING_UNRESOLVED','CLARIFICATION','Shipping responsibility unconfirmed',
    'The sample seller quote lists a shipping charge but does not identify the party responsible. The buyer assumption requires an explicit merchant response.');
  if (buyer.requestedDeliveryDeadline !== null) {
    add('DELIVERY_UNCONFIRMED','CLARIFICATION','Requested delivery date unconfirmed',
      'The buyer requested a delivery deadline, but no merchant delivery commitment is recorded.');
  }
  if (buyer.requestedDiscountBps > seller.maxDemoDiscountBps) {
    add('DISCOUNT_OVER_DEMO_LIMIT','REVIEW','Discount exceeds demonstration limit',
      'The buyer requests more than the 5% sample ceiling. This is not permission to change the quotation.');
  }
  return Object.freeze({
    mode: 'BROWSER_SYNTHETIC_ILLUSTRATION' as const,
    status: findings.some(x => x.severity === 'CONFLICT' || x.severity === 'REVIEW')
      ? 'BLOCKED_CONFLICT' as const : 'NEEDS_CLARIFICATION' as const,
    findings: Object.freeze(findings),
    canApprove: false as const, canInvoice: false as const,
    canPay: false as const, humanApprovalRecorded: false as const,
    evidenceVerifiedByD1: false as const,
  });
}
