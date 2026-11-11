import { useState } from 'react';
import {
  assessSyntheticBrowserTerms,
  previewBuyerPresets, previewSellerEvidence,
  type PreviewBuyerTerms,
} from './commercialConflictDemo';
import './CommercialConflictReview.css';

function cents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

/** A live, interactive *synthetic* visualization; no network or payment calls. */
export default function CommercialConflictReview() {
  const [buyer, setBuyer] = useState<PreviewBuyerTerms>(previewBuyerPresets.disagreement);
  const review = assessSyntheticBrowserTerms(previewSellerEvidence, buyer);
  const conflicts = review.findings.filter(x => x.severity === 'CONFLICT').length;
  const reviews = review.findings.filter(x => x.severity === 'REVIEW').length;
  const clarification = review.findings.filter(x => x.severity === 'CLARIFICATION').length;
  const update = <K extends keyof PreviewBuyerTerms>(key: K, value: PreviewBuyerTerms[K]) => {
    setBuyer(prev => ({ ...prev, [key]: value }));
  };
  return (
    <section className="tt-integrity" aria-label="Interactive commercial conflict review">
      <div className="tt-integrity-heading">
        <div>
          <p className="tt-integrity-kicker">DEAL INTEGRITY INTELLIGENCE · INTERACTIVE DEMO</p>
          <h2>Spot the gaps before the invoice.</h2>
          <p>Explore how a buyer and exporter can misunderstand the same quotation. Every finding is a nonbinding demonstration—no merchant has approved these terms.</p>
        </div>
        <span className="tt-integrity-chip">SAMPLE WORKFLOW · DEMO DATA</span>
      </div>
      <div className="tt-integrity-presets" aria-label="Example disagreement scenarios">
        <button type="button" onClick={() => setBuyer(previewBuyerPresets.disagreement)}>Shipping + 8% request</button>
        <button type="button" onClick={() => setBuyer(previewBuyerPresets.mismatch)}>Currency + quantity mismatch</button>
        <button type="button" onClick={() => setBuyer(previewBuyerPresets.clarification)}>Clarification only</button>
      </div>
      <div className="tt-integrity-columns">
        <div className="tt-integrity-seller">
          <div className="tt-integrity-coltop"><span>01 · SELLER EVIDENCE</span><strong>Illustrative</strong></div>
          <h3>Exporter's quotation</h3>
          <dl className="tt-integrity-facts">
            <div><dt>Quotation</dt><dd>DEMO-EXPORT-001</dd></div>
            <div><dt>Currency</dt><dd>USD</dd></div>
            <div><dt>Quantity</dt><dd>{previewSellerEvidence.quantity} bundles</dd></div>
            <div><dt>Goods subtotal</dt><dd>{cents(previewSellerEvidence.subtotalCents)}</dd></div>
            <div><dt>Listed shipping charge</dt><dd>{cents(previewSellerEvidence.quotedShippingChargeCents)}</dd></div>
            <div><dt>Who pays shipping?</dt><dd className="tt-integrity-pending">Not recorded</dd></div>
            <div><dt>Committed delivery</dt><dd className="tt-integrity-pending">Not recorded</dd></div>
            <div><dt>Sample discount guideline</dt><dd>5% · advisory only</dd></div>
          </dl>
          <p className="tt-integrity-source">Illustrative scenario data. Not an authenticated quotation or merchant approval.</p>
        </div>
        <div className="tt-integrity-buyer">
          <div className="tt-integrity-coltop"><span>02 · BUYER UNDERSTANDING</span><strong>Try different assumptions</strong></div>
          <h3>What does the buyer expect?</h3>
          <div className="tt-integrity-fields">
            <label>Currency
              <select aria-label="Buyer assumed currency" value={buyer.currency} onChange={e => update('currency',e.target.value as PreviewBuyerTerms['currency'])}>
                <option value="USD">USD</option><option value="EUR">EUR</option>
              </select>
            </label>
            <label>Quantity
              <select aria-label="Buyer assumed quantity" value={buyer.quantity} onChange={e => update('quantity',Number(e.target.value))}>
                <option value={2}>2 bundles</option><option value={3}>3 bundles</option>
              </select>
            </label>
            <label>Goods subtotal
              <select aria-label="Buyer assumed subtotal" value={buyer.assumedSubtotalCents} onChange={e => update('assumedSubtotalCents',Number(e.target.value))}>
                <option value={19800}>$198.00</option><option value={18000}>$180.00</option>
              </select>
            </label>
            <label>Who pays shipping?
              <select aria-label="Buyer assumed shipping responsibility" value={buyer.shippingPayer} onChange={e => update('shippingPayer',e.target.value as PreviewBuyerTerms['shippingPayer'])}>
                <option value="SELLER_PAYS">Seller includes shipping</option>
                <option value="BUYER_PAYS">Buyer pays separately</option>
                <option value="UNSPECIFIED">Not discussed</option>
              </select>
            </label>
            <label>Requested delivery
              <select aria-label="Buyer requested delivery deadline" value={buyer.requestedDeliveryDeadline ?? ''} onChange={e => update('requestedDeliveryDeadline',e.target.value || null)}>
                <option value="2026-11-20">By 20 November</option><option value="">No date requested</option>
              </select>
            </label>
            <label>Requested discount
              <select aria-label="Buyer requested discount" value={buyer.requestedDiscountBps} onChange={e => update('requestedDiscountBps',Number(e.target.value))}>
                <option value={800}>8% · exceeds demo policy</option><option value={400}>4% · within demo ceiling</option><option value={0}>None</option>
              </select>
            </label>
          </div>
          <p className="tt-integrity-source">The buyer's assumptions are untrusted and cannot replace seller terms or trigger payment.</p>
        </div>
      </div>
      <div className="tt-integrity-results" aria-live="polite">
        <div className="tt-integrity-resulthead">
          <div><span>03 · COMMERCIAL REVIEW</span><h3>Terms needing attention</h3></div>
          <strong className={review.status === 'BLOCKED_CONFLICT' ? 'tt-integrity-blocked' : 'tt-integrity-clarify'}>
            {review.status === 'BLOCKED_CONFLICT' ? 'Review required before approval' : 'Clarification needed'}
          </strong>
        </div>
        <p className="tt-integrity-counts">{conflicts} direct mismatches · {reviews} policy exceptions · {clarification} clarifications needed</p>
        <ul className="tt-integrity-findings">
          {review.findings.map(item => <li key={item.code}>
            <span className={'tt-integrity-severity tt-integrity-'+item.severity.toLowerCase()}>{item.severity}</span>
            <div><strong>{item.title}</strong><p>{item.detail}</p></div>
          </li>)}
        </ul>
        <div className="tt-integrity-next"><strong>Before terms can be approved:</strong> Clarify shipping responsibility and delivery commitment, resolve discrepancies against authenticated evidence, and obtain valid approvals. No action on this screen records agreement.</div>
        <div className="tt-integrity-locked" role="status">Approval, invoicing and payment remain unavailable in this simulated scenario</div>
      </div>
    </section>
  );
}
