/**
 * 09B-03-12-09E1 — trusted, local-only, read-only commercial terms assessment.
 * NOT an HTTP endpoint or authorization layer. Merchant membership/dealroom
 * access MUST be verified independently before calling this function.
 * No AI inference, payment calls, database writes, or approval transitions.
 *
 * Quotation JSON does not establish the shipping payer or an agreed delivery
 * deadline. Both MUST remain unresolved; a shipping charge is not consent.
 */
import { resolveTrustedNegotiationContext, type TrustedContextEnv } from './trusted-context.ts';
import { assessCommercialTerms, type IntegrityAssessment, type BuyerAssumptions } from './commercial-terms-integrity.ts';

export type TrustedTermsEnv = TrustedContextEnv & Readonly<{
  TRADETRUST_TERMS_REVIEW_MODE?: string;
}>;
export type TrustedTermsSelection = Readonly<{
  merchantId: string; quoteId: string; revisionNo: number;
}>;
export type TrustedTermsEvidence = Readonly<{
  currency: 'USD'; quantity: number; quotedSubtotalCents: number;
  quotedShippingChargeCents: number;
  shippingResponsibilityVerified: false;
  deliveryCommitmentVerified: false;
  sellerTermsOrigin: 'VERIFIED_LATEST_D1_QUOTE_REVISION';
  demoPolicyOrigin: 'SERVER_DEMO_CONFIG';
}>;
export type TrustedTermsResult = Readonly<{
  mode: 'LOCAL_TRUSTED_D1_READ_ONLY';
  merchantId: string; quoteId: string; revisionNo: number; quoteSha256: string;
  sellerEvidence: TrustedTermsEvidence;
  assessment: IntegrityAssessment;
  executableOfferAllowed: false;
  merchantApprovalRecorded: false;
  paymentInitiated: false;
}>;

type RevisionRow = {
  merchant_id: string; quote_id: string; revision_no: number;
  snapshot_sha256: string; snapshot_json: string; currency: string;
  subtotal_cents: number; discount_cents: number;
  shipping_cents: number; total_cents: number;
};
const SELECT_VERIFIED = `
 SELECT r.merchant_id, r.quote_id, r.revision_no,
   r.snapshot_sha256, r.snapshot_json, r.currency,
   r.subtotal_cents, r.discount_cents, r.shipping_cents, r.total_cents
 FROM quote_revisions r
 INNER JOIN quotes q
   ON q.id = r.quote_id AND q.merchant_id = r.merchant_id
 WHERE r.merchant_id = ? AND r.quote_id = ? AND r.revision_no = ?
   AND r.snapshot_sha256 = ?
   AND r.revision_no = (
     SELECT MAX(n.revision_no) FROM quote_revisions n
     WHERE n.merchant_id = r.merchant_id AND n.quote_id = r.quote_id
   )
 LIMIT 1
`;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_CENTS = 100_000_000;
function deny(): never { throw Error('TRADETRUST_TRUSTED_TERMS_REJECTED'); }
function plain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) &&
    Object.values(Object.getOwnPropertyDescriptors(v)).every(x => 'value' in x && x.enumerable);
}
function exact(v: unknown, keys: string): v is Record<string, unknown> {
  return plain(v) && Object.keys(v).sort().join('|') === keys;
}
function whole(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;
}
function verifySnapshot(value: unknown, row: RevisionRow): number {
  if (!exact(value, 'currency|discountBps|discountCents|lines|shippingCents|status|subtotalCents|totalCents') ||
      value.currency !== 'USD' || value.status !== 'PROPOSAL_REQUIRES_MERCHANT_APPROVAL' ||
      !whole(value.discountBps, 0, 1000) ||
      !whole(value.subtotalCents, 1, MAX_CENTS) ||
      !whole(value.discountCents, 0, MAX_CENTS) ||
      !whole(value.shippingCents, 0, MAX_CENTS) ||
      !whole(value.totalCents, 1, MAX_CENTS) ||
      !Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > 10 ||
      value.subtotalCents !== row.subtotal_cents ||
      value.discountCents !== row.discount_cents ||
      value.shippingCents !== row.shipping_cents ||
      value.totalCents !== row.total_cents) deny();
  let quantity = 0, subtotal = 0;
  const seen = new Set<string>();
  for (const line of value.lines) {
    if (!exact(line, 'lineCents|name|quantity|sku|unitCents') ||
        typeof line.sku !== 'string' || !ID.test(line.sku) || seen.has(line.sku) ||
        typeof line.name !== 'string' || line.name.length < 1 || line.name.length > 120 ||
        !whole(line.quantity, 1, 1_000_000) ||
        !whole(line.unitCents, 1, MAX_CENTS) ||
        !whole(line.lineCents, 1, MAX_CENTS) ||
        line.lineCents !== line.quantity * line.unitCents) deny();
    seen.add(line.sku);
    quantity += line.quantity;
    subtotal += line.lineCents;
  }
  if (!whole(quantity, 1, 1_000_000) || subtotal !== value.subtotalCents ||
      Math.floor(subtotal * value.discountBps / 10000) !== value.discountCents ||
      subtotal - value.discountCents + value.shippingCents !== value.totalCents) deny();
  return quantity;
}
/**
 * Calls trusted context resolver first. A second latest-revision SELECT is
 * pinned to that resolver's hash to prevent an intervening revision from
 * changing the meaning of the evidence. Both reads are read-only.
 */
export async function assessTrustedCommercialTermsLocal(
  env: TrustedTermsEnv | undefined,
  rawSelection: unknown,
  rawBuyer: unknown,
): Promise<TrustedTermsResult> {
  if (!env || env.TRADETRUST_TERMS_REVIEW_MODE !== 'LOCAL_SIMULATION' ||
      !env.DB || typeof env.DB.prepare !== 'function' ||
      !exact(rawSelection, 'merchantId|quoteId|revisionNo') ||
      typeof rawSelection.merchantId !== 'string' || !ID.test(rawSelection.merchantId) ||
      typeof rawSelection.quoteId !== 'string' || !ID.test(rawSelection.quoteId) ||
      !whole(rawSelection.revisionNo, 1, 2147483647)) deny();
  const selection = rawSelection as TrustedTermsSelection;
  // No public endpoint, no caller-controlled membership inference.
  const trusted = await resolveTrustedNegotiationContext(
    env, selection.merchantId, selection.quoteId, selection.revisionNo,
  );
  if (trusted.revisionNo !== selection.revisionNo ||
      trusted.policyOrigin !== 'SERVER_DEMO_CONFIG' ||
      trusted.executableOfferAllowed !== false ||
      trusted.context.merchantId !== selection.merchantId ||
      trusted.context.quoteId !== selection.quoteId ||
      !HASH.test(trusted.context.quoteSha256)) deny();

  let row: RevisionRow | null;
  try {
    row = await env.DB.prepare(SELECT_VERIFIED).bind(
      selection.merchantId, selection.quoteId, selection.revisionNo,
      trusted.context.quoteSha256,
    ).first<RevisionRow>();
  } catch { deny(); }
  if (!row || row.merchant_id !== selection.merchantId ||
      row.quote_id !== selection.quoteId || row.revision_no !== selection.revisionNo ||
      row.snapshot_sha256 !== trusted.context.quoteSha256 || row.currency !== 'USD' ||
      typeof row.snapshot_json !== 'string' || row.snapshot_json.length > 100000 ||
      !whole(row.subtotal_cents, 1, MAX_CENTS) ||
      !whole(row.discount_cents, 0, MAX_CENTS) ||
      !whole(row.shipping_cents, 0, MAX_CENTS) ||
      !whole(row.total_cents, 1, MAX_CENTS)) deny();
  let snapshot: unknown;
  try { snapshot = JSON.parse(row.snapshot_json); } catch { deny(); }
  const bytes = new TextEncoder().encode(row.snapshot_json);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(x => x.toString(16).padStart(2, '0')).join('');
  if (digest !== trusted.context.quoteSha256) deny();
  const quantity = verifySnapshot(snapshot, row);
  const assessment = assessCommercialTerms(
    { merchantId: selection.merchantId, quoteId: selection.quoteId,
      revisionNo: selection.revisionNo, quoteSha256: digest },
    { currency: 'USD', quantity, quotedSubtotalCents: row.subtotal_cents,
      shippingPayer: 'UNSPECIFIED', knownShippingCents: row.shipping_cents,
      deliveryDeadline: null, maxDiscountBps: trusted.context.maxDiscountBps },
    rawBuyer as BuyerAssumptions,
  );
  if (assessment.nonBinding !== true || assessment.executableOfferAllowed !== false ||
      assessment.merchantApprovalRecorded !== false || assessment.paymentInitiated !== false ||
      assessment.agreementVerified !== false) deny();
  return Object.freeze({
    mode: 'LOCAL_TRUSTED_D1_READ_ONLY' as const,
    merchantId: selection.merchantId, quoteId: selection.quoteId,
    revisionNo: selection.revisionNo, quoteSha256: digest,
    sellerEvidence: Object.freeze({
      currency: 'USD' as const, quantity,
      quotedSubtotalCents: row.subtotal_cents,
      quotedShippingChargeCents: row.shipping_cents,
      shippingResponsibilityVerified: false as const,
      deliveryCommitmentVerified: false as const,
      sellerTermsOrigin: 'VERIFIED_LATEST_D1_QUOTE_REVISION' as const,
      demoPolicyOrigin: 'SERVER_DEMO_CONFIG' as const,
    }),
    assessment,
    executableOfferAllowed: false as const,
    merchantApprovalRecorded: false as const,
    paymentInitiated: false as const,
  });
}
