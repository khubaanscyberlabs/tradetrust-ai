/**
 * TradeTrust 09B-03-12-09D — Deterministic cross-border trade-term integrity.
 * Internal, offline, and advisory. No AI, HTTP, D1, approvals or payment calls.
 *
 * Inputs MUST be independently authenticated/authorized and server-resolved.
 * A quote hash is a referent only; this module does NOT verify D1 provenance.
 * Buyer claims are structured declarations, NOT extracted from free text.
 * Agreement status is NEVER equivalent to a legally accepted contract.
 */
export type ShippingPayer = 'BUYER_PAYS' | 'SELLER_PAYS' | 'UNSPECIFIED';
export type DealIdentity = Readonly<{
  merchantId: string; quoteId: string; revisionNo: number; quoteSha256: string;
}>;
export type SellerTerms = Readonly<{
  currency: 'USD'; quantity: number; quotedSubtotalCents: number;
  shippingPayer: ShippingPayer; knownShippingCents: number | null;
  deliveryDeadline: string | null; maxDiscountBps: number;
}>;
export type BuyerAssumptions = Readonly<{
  currency: string | null; quantity: number | null; assumedSubtotalCents: number | null;
  shippingPayer: ShippingPayer | null; requestedDeliveryDeadline: string | null;
  requestedDiscountBps: number | null;
}>;
export type TermFindingCode =
  | 'CURRENCY_CONFLICT' | 'QUANTITY_CONFLICT' | 'SUBTOTAL_CONFLICT'
  | 'SHIPPING_PAYER_CONFLICT' | 'SHIPPING_UNRESOLVED'
  | 'DELIVERY_DEADLINE_CONFLICT' | 'DELIVERY_UNCONFIRMED'
  | 'DISCOUNT_OVER_DEMO_LIMIT' | 'BUYER_TERMS_INCOMPLETE';
export type TermFinding = Readonly<{
  code: TermFindingCode;
  impact: 'CONFLICT' | 'CLARIFICATION' | 'REVIEW';
  explanation: string;
  illustrativeShippingExposureCents: number | null;
}>;
export type IntegrityAssessment = Readonly<{
  mode: 'OFFLINE_STRUCTURED_COMPARISON';
  merchantId: string; quoteId: string; revisionNo: number; quoteSha256: string;
  status: 'BLOCKED_CONFLICT' | 'NEEDS_CLARIFICATION' | 'ALIGNED_UNVERIFIED';
  findings: readonly TermFinding[];
  currency: 'USD';
  nonBinding: true; merchantApprovalRecorded: false;
  executableOfferAllowed: false; paymentInitiated: false;
  agreementVerified: false;
}>;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const SHIPPING = ['BUYER_PAYS','SELLER_PAYS','UNSPECIFIED'] as const;
const MONEY_MAX = 100_000_000;
function deny(code: string): never { throw Error(code); }
function exactObject(value: unknown, keys: string): value is Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.keys(value).sort().join('|') !== keys) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every(d => 'value' in d && d.enumerable);
}
function whole(value: unknown, lower: number, upper: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= lower && value <= upper;
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d] = value.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const candidate = new Date(Date.UTC(y,m-1,d));
  return candidate.getUTCFullYear() === y && candidate.getUTCMonth() === m-1 && candidate.getUTCDate() === d;
}
function validIdentity(value: unknown): asserts value is DealIdentity {
  if (!exactObject(value, 'merchantId|quoteId|quoteSha256|revisionNo') ||
      typeof value.merchantId !== 'string' || !ID.test(value.merchantId) ||
      typeof value.quoteId !== 'string' || !ID.test(value.quoteId) ||
      !whole(value.revisionNo,1,2147483647) ||
      typeof value.quoteSha256 !== 'string' || !SHA.test(value.quoteSha256)) {
    deny('TRADETRUST_TERMS_IDENTITY_REJECTED');
  }
}
function validSeller(value: unknown): asserts value is SellerTerms {
  if (!exactObject(value,'currency|deliveryDeadline|knownShippingCents|maxDiscountBps|quantity|quotedSubtotalCents|shippingPayer') ||
      value.currency !== 'USD' || !whole(value.quantity,1,1000000) ||
      !whole(value.quotedSubtotalCents,1,MONEY_MAX) ||
      !SHIPPING.includes(value.shippingPayer as ShippingPayer) ||
      (value.knownShippingCents !== null && !whole(value.knownShippingCents,0,MONEY_MAX)) ||
      (value.deliveryDeadline !== null && !validDate(value.deliveryDeadline)) ||
      !whole(value.maxDiscountBps,0,500)) {
    deny('TRADETRUST_TERMS_SELLER_REJECTED');
  }
}
function validBuyer(value: unknown): asserts value is BuyerAssumptions {
  if (!exactObject(value,'assumedSubtotalCents|currency|quantity|requestedDeliveryDeadline|requestedDiscountBps|shippingPayer') ||
      (value.currency !== null && (typeof value.currency !== 'string' ||
       !/^[A-Z]{3}$/.test(value.currency))) ||
      (value.quantity !== null && !whole(value.quantity,1,1000000)) ||
      (value.assumedSubtotalCents !== null && !whole(value.assumedSubtotalCents,0,MONEY_MAX)) ||
      (value.shippingPayer !== null && !SHIPPING.includes(value.shippingPayer as ShippingPayer)) ||
      (value.requestedDeliveryDeadline !== null && !validDate(value.requestedDeliveryDeadline)) ||
      (value.requestedDiscountBps !== null && !whole(value.requestedDiscountBps,0,10000))) {
    deny('TRADETRUST_TERMS_BUYER_REJECTED');
  }
}
/**
 * Compare *structured* buyer assumptions with independently verified seller
 * facts. Even ALIGNED_UNVERIFIED is not consent. No exchange-rate assumptions,
 * discount execution, invoice amounts, or approval transitions are produced.
 */
export function assessCommercialTerms(
  rawIdentity: unknown, rawSeller: unknown, rawBuyer: unknown,
): IntegrityAssessment {
  validIdentity(rawIdentity); validSeller(rawSeller); validBuyer(rawBuyer);
  const id = rawIdentity, seller = rawSeller, buyer = rawBuyer;
  const findings: TermFinding[] = [];
  function add(code: TermFindingCode, impact: TermFinding['impact'],
               explanation: string, shippingExposure: number | null = null): void {
    findings.push(Object.freeze({code, impact, explanation,
      illustrativeShippingExposureCents: shippingExposure}));
  }
  if (buyer.currency !== null && buyer.currency !== seller.currency) {
    add('CURRENCY_CONFLICT','CONFLICT',
      'Buyer and merchant selected different currencies. No currency conversion has been authorized.');
  }
  if (buyer.quantity !== null && buyer.quantity !== seller.quantity) {
    add('QUANTITY_CONFLICT','CONFLICT',
      'Buyer quantity differs from the merchant quotation.');
  }
  if (buyer.assumedSubtotalCents !== null &&
      buyer.assumedSubtotalCents !== seller.quotedSubtotalCents) {
    add('SUBTOTAL_CONFLICT','CONFLICT',
      'Buyer assumed a different item subtotal. No invoice total was calculated.');
  }
  if (buyer.shippingPayer !== null && seller.shippingPayer !== 'UNSPECIFIED' &&
      buyer.shippingPayer !== 'UNSPECIFIED' && buyer.shippingPayer !== seller.shippingPayer) {
    add('SHIPPING_PAYER_CONFLICT','CONFLICT',
      'Buyer and merchant disagree about who bears shipping costs.',seller.knownShippingCents);
  } else if (buyer.shippingPayer === null || buyer.shippingPayer === 'UNSPECIFIED' ||
             seller.shippingPayer === 'UNSPECIFIED') {
    add('SHIPPING_UNRESOLVED','CLARIFICATION',
      'Shipping cost responsibility is not mutually specified.');
  }
  if (buyer.requestedDeliveryDeadline !== null && seller.deliveryDeadline !== null &&
      buyer.requestedDeliveryDeadline !== seller.deliveryDeadline) {
    add('DELIVERY_DEADLINE_CONFLICT','CONFLICT',
      'Buyer requested a delivery date different from the merchant commitment.');
  } else if (buyer.requestedDeliveryDeadline !== null && seller.deliveryDeadline === null) {
    add('DELIVERY_UNCONFIRMED','CLARIFICATION',
      'Buyer requested a delivery date not yet committed to by the merchant.');
  } else if (buyer.requestedDeliveryDeadline === null && seller.deliveryDeadline !== null) {
    add('DELIVERY_UNCONFIRMED','CLARIFICATION',
      'Buyer has not confirmed the merchant delivery deadline.');
  }
  if (buyer.requestedDiscountBps !== null && buyer.requestedDiscountBps > seller.maxDiscountBps) {
    add('DISCOUNT_OVER_DEMO_LIMIT','REVIEW',
      'Requested discount exceeds the server demonstration ceiling; merchant review is necessary.');
  }
  if (buyer.currency === null || buyer.quantity === null || buyer.assumedSubtotalCents === null ||
      buyer.requestedDiscountBps === null) {
    add('BUYER_TERMS_INCOMPLETE','CLARIFICATION',
      'One or more buyer commercial assumptions are missing.');
  }
  const status: IntegrityAssessment['status'] = findings.some(x=>x.impact==='CONFLICT'||x.impact==='REVIEW') ?
    'BLOCKED_CONFLICT' : findings.length ? 'NEEDS_CLARIFICATION' : 'ALIGNED_UNVERIFIED';
  return Object.freeze({
    mode: 'OFFLINE_STRUCTURED_COMPARISON' as const,
    merchantId: id.merchantId, quoteId: id.quoteId,
    revisionNo: id.revisionNo, quoteSha256: id.quoteSha256,
    status, findings: Object.freeze(findings), currency: 'USD' as const,
    nonBinding: true as const, merchantApprovalRecorded: false as const,
    executableOfferAllowed: false as const, paymentInitiated: false as const,
    agreementVerified: false as const,
  });
}
