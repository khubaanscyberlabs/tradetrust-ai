import { useState } from 'react';

/** D1-backed, deterministic, authenticated review. No AI or payment calls. */
type EvidenceRef = Readonly<{
  merchantId: string;
  quoteId: string;
  revision: number;
  snapshotSha256: string;
  currency: 'USD';
  subtotalCents: number;
  shippingCents: number;
  line: Readonly<{quantity: number}>;
}>;

type BuyerTerms = {
  currency: 'USD' | 'EUR';
  quantity: number;
  assumedSubtotalCents: number;
  shippingPayer: 'SELLER_PAYS' | 'BUYER_PAYS' | 'UNSPECIFIED';
  requestedDeliveryDeadline: string | null;
  requestedDiscountBps: number;
};

/** Actual backend finding contract, not the synthetic browser review schema. */
type Finding = Readonly<{
  code: string;
  impact: unknown; // Server-owned advisory metadata; never financial authority.
  explanation: string;
  illustrativeShippingExposureCents: number | null;
}>;

type DisplayLevel = 'CONFLICT' | 'REVIEW' | 'CLARIFICATION';
const DISPLAY_TITLES: Readonly<Record<string, string>> = Object.freeze({
  SHIPPING_UNRESOLVED: 'Shipping responsibility unclear',
  DELIVERY_UNCONFIRMED: 'Delivery date not confirmed',
  DISCOUNT_OVER_DEMO_LIMIT: 'Discount requires merchant review',
  CURRENCY_CONFLICT: 'Currency mismatch',
  CURRENCY_MISMATCH: 'Currency mismatch',
  QUANTITY_CONFLICT: 'Quantity mismatch',
  QUANTITY_MISMATCH: 'Quantity mismatch',
  SUBTOTAL_CONFLICT: 'Goods subtotal mismatch',
  SUBTOTAL_MISMATCH: 'Goods subtotal mismatch',
});
function displayLevel(code: string): DisplayLevel {
  if (code === 'DISCOUNT_OVER_DEMO_LIMIT') return 'REVIEW';
  if (code === 'SHIPPING_UNRESOLVED' || code === 'DELIVERY_UNCONFIRMED') return 'CLARIFICATION';
  if (code === 'CURRENCY_CONFLICT' || code === 'CURRENCY_MISMATCH' ||
      code === 'QUANTITY_CONFLICT' || code === 'QUANTITY_MISMATCH' ||
      code === 'SUBTOTAL_CONFLICT' || code === 'SUBTOTAL_MISMATCH') return 'CONFLICT';
  return 'REVIEW'; // Unknown findings require manual review; never silently clear.
}
function displayTitle(code: string): string {
  return DISPLAY_TITLES[code] ?? 'Additional finding — manual review required';
}

function displaySummary(item: Finding): string {
  switch (item.code) {
    case 'SHIPPING_UNRESOLVED':
      return 'The buyer and seller have not established who will pay shipping costs.';
    case 'DELIVERY_UNCONFIRMED':
      return 'The requested delivery date has not been confirmed by the merchant.';
    case 'DISCOUNT_OVER_DEMO_LIMIT':
      return 'The requested discount exceeds the demonstration policy limit and needs merchant review.';
    default:
      return item.explanation;
  }
}

function validFinding(value: unknown): value is Finding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  const keys = Object.keys(f).sort().join('|');
  if (keys !== 'code|explanation|illustrativeShippingExposureCents|impact' ||
      typeof f.code !== 'string' || !/^[A-Z][A-Z0-9_]{2,79}$/.test(f.code) ||
      typeof f.explanation !== 'string' || f.explanation.length < 1 ||
      f.explanation.length > 4000 || f.impact === undefined) return false;
  const exposure = f.illustrativeShippingExposureCents;
  return exposure === null ||
    (typeof exposure === 'number' && Number.isSafeInteger(exposure) &&
      exposure >= 0 && exposure <= 100_000_000);
}

type VerifiedReview = Readonly<{
  mode: 'LOCAL_TRUSTED_D1_READ_ONLY';
  merchantId: string;
  quoteId: string;
  revisionNo: number;
  quoteSha256: string;
  sellerEvidence: Readonly<{
    currency: 'USD';
    quantity: number;
    quotedSubtotalCents: number;
    quotedShippingChargeCents: number;
    shippingResponsibilityVerified: false;
    deliveryCommitmentVerified: false;
    sellerTermsOrigin: 'VERIFIED_LATEST_D1_QUOTE_REVISION';
    demoPolicyOrigin: 'SERVER_DEMO_CONFIG';
  }>;
  assessment: Readonly<{
    status: string;
    findings: readonly Finding[];
    nonBinding: true;
    executableOfferAllowed: false;
    merchantApprovalRecorded: false;
    paymentInitiated: false;
    agreementVerified: false;
  }>;
  executableOfferAllowed: false;
  merchantApprovalRecorded: false;
  paymentInitiated: false;
}>;

const presets = {
  shipping: {
    currency: 'USD', quantity: 2, assumedSubtotalCents: 8400,
    shippingPayer: 'SELLER_PAYS', requestedDeliveryDeadline: '2026-11-20',
    requestedDiscountBps: 800,
  },
  mismatch: {
    currency: 'EUR', quantity: 3, assumedSubtotalCents: 8000,
    shippingPayer: 'SELLER_PAYS', requestedDeliveryDeadline: '2026-11-20',
    requestedDiscountBps: 800,
  },
  clarify: {
    currency: 'USD', quantity: 2, assumedSubtotalCents: 8400,
    shippingPayer: 'UNSPECIFIED', requestedDeliveryDeadline: null,
    requestedDiscountBps: 400,
  },
} as const satisfies Record<string, BuyerTerms>;

function verifyResponse(payload: unknown, evidence: EvidenceRef): VerifiedReview {
  if (!payload || typeof payload !== 'object') throw Error('Invalid server response.');
  const { review } = payload as {review?: VerifiedReview};
  if (!review || review.mode !== 'LOCAL_TRUSTED_D1_READ_ONLY' ||
      review.merchantId !== evidence.merchantId ||
      review.quoteId !== evidence.quoteId ||
      review.revisionNo !== evidence.revision ||
      review.quoteSha256 !== evidence.snapshotSha256 ||
      review.executableOfferAllowed !== false ||
      review.merchantApprovalRecorded !== false ||
      review.paymentInitiated !== false ||
      !review.sellerEvidence ||
      review.sellerEvidence.currency !== evidence.currency ||
      review.sellerEvidence.quantity !== evidence.line.quantity ||
      review.sellerEvidence.quotedSubtotalCents !== evidence.subtotalCents ||
      review.sellerEvidence.quotedShippingChargeCents !== evidence.shippingCents ||
      review.sellerEvidence.shippingResponsibilityVerified !== false ||
      review.sellerEvidence.deliveryCommitmentVerified !== false ||
      review.sellerEvidence.sellerTermsOrigin !== 'VERIFIED_LATEST_D1_QUOTE_REVISION' ||
      review.sellerEvidence.demoPolicyOrigin !== 'SERVER_DEMO_CONFIG' ||
      !review.assessment || review.assessment.nonBinding !== true ||
      review.assessment.executableOfferAllowed !== false ||
      review.assessment.merchantApprovalRecorded !== false ||
      review.assessment.paymentInitiated !== false ||
      review.assessment.agreementVerified !== false ||
      !Array.isArray(review.assessment.findings) ||
      review.assessment.findings.length > 30 ||
      !review.assessment.findings.every(validFinding) ||
      new Set(review.assessment.findings.map(item => item.code)).size !==
        review.assessment.findings.length) {
    throw Error('D1-backed review evidence failed validation.');
  }
  return review;
}

const money = (cents: number) => '$' + (cents / 100).toFixed(2);
const container = {borderTop: '1px solid currentColor', paddingTop: '1rem', marginTop: '1.25rem'} as const;
const control = {display: 'block', width: '100%', padding: '0.45rem', marginTop: '0.35rem'} as const;

export default function ProtectedTermsReview({evidence}: {evidence: EvidenceRef}) {
  const [buyer, setBuyer] = useState<BuyerTerms>({...presets.shipping});
  const [review, setReview] = useState<VerifiedReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Select buyer assumptions, then run a protected D1 review.');

  function update<K extends keyof BuyerTerms>(key: K, value: BuyerTerms[K]): void {
    setBuyer(previous => ({...previous, [key]: value}));
    setReview(null);
    setMessage('Buyer assumptions changed. Rerun the protected review.');
  }

  function preset(value: BuyerTerms): void {
    setBuyer({...value});
    setReview(null);
    setMessage('Preset selected. No agreement or approval has been recorded.');
  }

  async function reviewTerms(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setReview(null);
    try {
      const response = await fetch('/api/merchant/terms-review', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          merchantId: evidence.merchantId,
          quoteId: evidence.quoteId,
          revisionNo: evidence.revision,
          buyer,
        }),
      });
      if (!response.ok) {
        if (response.status === 403) throw Error('Merchant session expired or authorization denied.');
        if (response.status === 404) throw Error('Protected local terms review is disabled.');
        if (response.status === 422) throw Error('Buyer assumptions were rejected.');
        throw Error('Protected D1 review unavailable (' + response.status + ').');
      }
      const checked = verifyResponse(await response.json(), evidence);
      setReview(checked);
      setMessage('Verified latest D1 quote assessed. Advisory only; no AI or PayPal operation.');
    } catch (error) {
      setReview(null);
      setMessage(error instanceof Error ? error.message : 'Protected review unavailable.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={container} aria-label="Protected D1 commercial terms review">
      <span className="tt-overline">09P-08 · REAL D1-BACKED COMMERCIAL REVIEW · NO MODEL CALL</span>
      <h4>Check a buyer's understanding against the approved quotation</h4>
      <p className="tt-muted">Seller quotation: USD {money(evidence.subtotalCents)} goods, {evidence.line.quantity} units, and {money(evidence.shippingCents)} listed shipping. The merchant approved this quote; the buyer's understanding, shipping responsibility and delivery commitment are not thereby agreed.</p>
      <div style={{display:'flex', flexWrap:'wrap', gap:'0.5rem', marginBottom:'0.75rem'}}>
        <button type="button" disabled={busy} onClick={() => preset(presets.shipping)}>Shipping + 8% discount</button>
        <button type="button" disabled={busy} onClick={() => preset(presets.mismatch)}>EUR + 3 units mismatch</button>
        <button type="button" disabled={busy} onClick={() => preset(presets.clarify)}>Clarification only</button>
      </div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:'0.65rem', marginBottom:'0.9rem'}}>
        <label>Buyer currency
          <select style={control} value={buyer.currency} disabled={busy} onChange={event => update('currency', event.target.value as BuyerTerms['currency'])}>
            <option value="USD">USD</option><option value="EUR">EUR</option>
          </select>
        </label>
        <label>Buyer quantity
          <select style={control} value={buyer.quantity} disabled={busy} onChange={event => update('quantity', Number(event.target.value))}>
            <option value={2}>2 units</option><option value={3}>3 units</option>
          </select>
        </label>
        <label>Buyer goods subtotal
          <select style={control} value={buyer.assumedSubtotalCents} disabled={busy} onChange={event => update('assumedSubtotalCents', Number(event.target.value))}>
            <option value={8400}>84.00 (numeric)</option><option value={8000}>80.00 (numeric)</option>
          </select>
        </label>
        <label>Shipping responsibility assumed
          <select style={control} value={buyer.shippingPayer} disabled={busy} onChange={event => update('shippingPayer', event.target.value as BuyerTerms['shippingPayer'])}>
            <option value="SELLER_PAYS">Seller pays</option><option value="BUYER_PAYS">Buyer pays</option><option value="UNSPECIFIED">Not agreed</option>
          </select>
        </label>
        <label>Requested delivery
          <select style={control} value={buyer.requestedDeliveryDeadline ?? ''} disabled={busy} onChange={event => update('requestedDeliveryDeadline', event.target.value || null)}>
            <option value="2026-11-20">By 20 November</option><option value="">No date requested</option>
          </select>
        </label>
        <label>Buyer discount request
          <select style={control} value={buyer.requestedDiscountBps} disabled={busy} onChange={event => update('requestedDiscountBps', Number(event.target.value))}>
            <option value={800}>8% (policy review)</option><option value={400}>4% (advisory only)</option><option value={0}>0%</option>
          </select>
        </label>
      </div>
      <button type="button" className="tt-primary" disabled={busy} onClick={reviewTerms}>
        {busy ? 'Verifying latest D1 quote…' : 'Compare buyer terms with approved quotation'}
      </button>
      <p className="tt-muted" role="status" aria-live="polite">{message}</p>
      {review && <div className="tt-integrity-results tt-verified-review" aria-live="polite">
        <div className="tt-verified-review-heading">
          <div>
            <span className="tt-verified-review-kicker">VERIFIED SELLER TERMS · LOCAL DEMO</span>
            <h3>{review.assessment.findings.length === 0
              ? 'No issues flagged in this review'
              : `${review.assessment.findings.length} ${review.assessment.findings.length === 1 ? 'item needs' : 'items need'} attention`}</h3>
          </div>
          <span className="tt-verified-review-status">
            {review.assessment.status === 'BLOCKED_CONFLICT'
              ? 'Approval blocked'
              : 'Approval not recorded'}
          </span>
        </div>
        <p className="tt-verified-review-intro">
          Checked against authenticated seller terms and server-side demonstration rules.
          This review does not establish a binding agreement.
        </p>
        <ul className="tt-integrity-findings tt-verified-review-list">
          {review.assessment.findings.map(item => <li key={item.code}>
            <span className={'tt-integrity-severity tt-integrity-' + displayLevel(item.code).toLowerCase()}>
              {displayLevel(item.code)}
            </span>
            <div className="tt-verified-review-finding">
              <strong>{displayTitle(item.code)}</strong>
              <p>{displaySummary(item)}</p>
            </div>
          </li>)}
        </ul>
        <details className="tt-verified-review-audit">
          <summary>Technical verification details</summary>
          <div className="tt-verified-review-audit-body">
            <p>Server assessment: <code>{review.assessment.status}</code></p>
            <p>Source: authenticated D1 evidence and server-owned demonstration rules.</p>
            <ul>
              {review.assessment.findings.map(item => <li key={item.code}>
                <code>{item.code}</code>
                <span>{item.explanation}</span>
              </li>)}
            </ul>
          </div>
        </details>
        <p className="tt-verified-review-footer">
          No AI inference, new merchant approval, invoice or payment was initiated by this review.
          The findings are advisory and do not establish accepted trade terms.
        </p>
      </div>}
    </section>
  );
}
