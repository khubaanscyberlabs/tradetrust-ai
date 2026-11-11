import { useState } from 'react';
import { money, previewQuote, type DemoShipping } from './scenario';
import CommercialConflictReview from './CommercialConflictReview';
import VerifiedMerchantPanel from './VerifiedMerchantPanel';
import './TradeTrustDemo.css';

type DemoStage = 'ENQUIRY' | 'QUOTE_READY' | 'MOCK_APPROVED' | 'MOCK_DRAFT';
const milestones: ReadonlyArray<{ id: DemoStage; label: string; detail: string }> = [
  { id: 'ENQUIRY', label: 'Buyer request', detail: 'Synthetic buyer request' },
  { id: 'QUOTE_READY', label: 'Review quotation', detail: 'Illustrative amounts only' },
  { id: 'MOCK_APPROVED', label: 'Approval preview', detail: 'Simulation; no approval recorded' },
  { id: 'MOCK_DRAFT', label: 'Invoice preview', detail: 'Simulation; no provider invoice' },
];
const labels = ['ENQUIRY', 'QUOTE_READY', 'MOCK_APPROVED', 'MOCK_DRAFT'] as const;
function Icon({ name }: {name: string}) {
  const icons: Record<string, string> = {lock: '▣', shield:'◇', arrow:'↗', check:'✓', reset:'↺'};
  return <span aria-hidden="true">{icons[name] ?? '•'}</span>;
}
export default function TradeTrustDemo() {
  const [stage, setStage] = useState<DemoStage>('ENQUIRY');
  const [quantity, setQuantity] = useState(1);
  const [shipping, setShipping] = useState<DemoShipping>('STANDARD');
  const [discountBps, setDiscountBps] = useState(0);
  const [notice, setNotice] = useState('Choose the sample terms and generate a quotation preview.');
  const [tab, setTab] = useState<'buyer' | 'merchant'>('buyer');
  const quote = previewQuote({quantity, shipping, discountBps});
  const index = labels.indexOf(stage);
  const locked = stage !== 'ENQUIRY';
  const reset = () => {
    setStage('ENQUIRY'); setQuantity(1); setShipping('STANDARD');
    setDiscountBps(0); setTab('buyer');
    setNotice('Simulation reset. No external system was changed.');
  };
  const request = () => {
    if (!quote.eligible) {
      setNotice('Policy rejected this offer: the illustration allows at most a 5% discount.');
      return;
    }
    setStage('QUOTE_READY'); setTab('merchant');
    setNotice('Sample quote prepared locally. Merchant approval is a UI simulation.');
  };
  const approve = () => {
    if (stage !== 'QUOTE_READY' || !quote.eligible) return;
    setStage('MOCK_APPROVED');
    setNotice('Approval preview recorded in browser memory only. No D1 approval exists.');
  };
  const draft = () => {
    if (stage !== 'MOCK_APPROVED') return;
    setStage('MOCK_DRAFT');
    setNotice('Invoice preview generated locally. No PayPal API call or payment occurred.');
  };
  return (
    <div className="tt-page">
      <div className="tt-toprule" />
      <header className="tt-header">
        <div className="tt-brand"><span className="tt-brandmark">T<span>↗</span></span>
          <span><strong>TradeTrust <em>AI</em></strong><small>Cross-border dealroom</small></span></div>
        <div className="tt-header-right"><span className="tt-simulation">● LOCAL DEALROOM DEMO</span><span className="tt-lock"><Icon name="lock" /> Local verified merchant evidence</span></div>
      </header>
      <main className="tt-shell">
        <section className="tt-hero">
          <div><p className="tt-eyebrow">AI-ASSISTED TRADE · HUMAN-APPROVED TERMS</p>
            <h1>Clarity before<br/><i>commitment.</i></h1>
            <p className="tt-intro">Review buyer requests, spot unresolved trade terms, and keep financial commitments under merchant control.</p>
          </div>
          <div className="tt-hero-card tt-hero-trust">
  <span className="tt-hero-card-top">COMMERCE WITH ACCOUNTABILITY</span>
  <h2>Resolve the details.<br/><em>Protect the decision.</em></h2>
  <p>Identify unclear terms before they become financial commitments.</p>
  <div className="tt-hero-trust-grid" aria-label="TradeTrust safeguards">
    <span><b>01</b> Review trade terms</span>
    <span><b>02</b> Merchant control</span>
    <span><b>03</b> Verify invoice state</span>
  </div>
</div>
        </section>
        <div className="tt-context-band" role="note">
  <strong>INTERACTIVE SIMULATION</strong>
  <span>Sample quotes and conflict checks are synthetic. The merchant panel displays separate, read-only local D1 evidence. This page does not run AI, create PayPal invoices or initiate payments.</span>
</div>
<section className="tt-pipeline" aria-label="Demo workflow milestones">
          {milestones.map((step, i) => <div key={step.id} className={'tt-step '+(i<=index?'reached':'')}>
            <span className="tt-step-number">{i<index ? '✓' : String(i+1).padStart(2,'0')}</span>
            <div><strong>{step.label}</strong><small>{step.detail}</small></div></div>)}
        </section>
        <div className="tt-main-grid">
          <section className="tt-panel" aria-label="Buyer and merchant controls">
            <div className="tt-tabs" role="tablist" aria-label="Dealroom view">
              <button className={tab==='buyer'?'active':''} onClick={()=>setTab('buyer')} role="tab" aria-selected={tab==='buyer'}>Buyer workspace</button>
              <button className={tab==='merchant'?'active':''} onClick={()=>setTab('merchant')} role="tab" aria-selected={tab==='merchant'}>Merchant desk</button>
            </div>
            {tab==='buyer' ? <div className="tt-panel-body">
              <span className="tt-overline">SAMPLE BUYER ENQUIRY</span><h2>Start with a buyer request.</h2>
              <p className="tt-muted">Try the sample ordering options. The negotiation policy below is deterministic, not AI-powered.</p>
              <div className="tt-message"><span className="tt-avatar">B</span><p>Hi! I'm sourcing a cross-border artisan bundle. Could you share the best quote including shipping?</p></div>
              <div className="tt-fields"><label>Quantity<select value={quantity} onChange={e=>setQuantity(Number(e.target.value))} disabled={locked}>{[1,2,3,4,5].map(q=><option key={q} value={q}>{q} bundle{q===1?'':'s'}</option>)}</select></label>
                <label>Shipping<select value={shipping} onChange={e=>setShipping(e.target.value as DemoShipping)} disabled={locked}><option value="STANDARD">Standard · $10</option><option value="EXPRESS">Express · $18</option></select></label>
                <label className="tt-full">Requested discount<select value={discountBps} onChange={e=>setDiscountBps(Number(e.target.value))} disabled={locked}><option value={0}>No discount</option><option value={200}>2% request</option><option value={400}>4% request</option><option value={800}>8% request — exceeds policy</option></select></label></div>
              {!quote.eligible && <p className="tt-policy" role="alert">This sample exceeds the 5% merchant policy limit. Select a smaller discount.</p>}
              {stage==='ENQUIRY' ? <button className="tt-primary" onClick={request}>Preview sample quotation <Icon name="arrow"/></button> : <div className="tt-confirmation"><Icon name="check"/> Buyer terms locked in this preview. Use Reset to start another scenario.</div>}
            </div> : <div className="tt-panel-body">
              <VerifiedMerchantPanel />
              <span className="tt-overline">SIMULATED MERCHANT APPROVAL WORKSPACE</span><h2 className="tt-human-approval-heading">The merchant makes the final call.</h2>
              <p className="tt-muted">This is a simulated approval screen. Only an authenticated merchant can approve the server-side quotation.</p>
              <div className="tt-merchant-card"><div><span className="tt-avatar tt-merchant-avatar">M</span><div><strong>Sample merchant</strong><small>Illustrative seller · USD settlement</small></div></div><span className="tt-local-label">DEMO ONLY</span></div>
              <div className="tt-approval-rows"><span>Quotation status</span><strong>{stage==='ENQUIRY'?'Not yet requested': 'Sample terms generated'}</strong><span>Requested discount</span><strong>{discountBps/100}%</strong><span>Proposed total</span><strong>${money(quote.totalCents)}</strong></div>
              {stage==='QUOTE_READY' && <button className="tt-primary" onClick={approve}>Simulate merchant approval <Icon name="check"/></button>}
              {stage==='MOCK_APPROVED' && <button className="tt-primary" onClick={draft}>Generate invoice preview <Icon name="arrow"/></button>}
              {stage==='MOCK_DRAFT' && <div className="tt-confirmation"><Icon name="check"/> Sample draft stage reached. PayPal has not been contacted.</div>}
              {stage==='ENQUIRY' && <div className="tt-empty">Generate a quotation from the buyer workspace to enable this sample action.</div>}
            </div>}
          </section>
          <aside className="tt-panel tt-quote" aria-label="Quote summary">
            <div className="tt-quote-header"><span className="tt-overline">COMMERCIAL TERMS</span><span className="tt-local-label">SIMULATED</span></div>
            <h2>Sample quote summary</h2><p className="tt-muted">Illustrative USD figures, not a live merchant offer.</p>
            <div className="tt-product"><span className="tt-product-art">◎</span><div><strong>Artisan export bundle</strong><small>Synthetic catalog SKU · DEMO-001</small><small>Unit price $99.00 × {quantity}</small></div></div>
            <div className="tt-amounts"><div><span>Subtotal</span><strong>${money(quote.subtotalCents)}</strong></div><div><span>Discount ({quote.eligible?discountBps/100:0}%)</span><strong>−${money(quote.discountCents)}</strong></div><div><span>{shipping==='STANDARD'?'Standard':'Express'} shipping</span><strong>${money(quote.shippingCents)}</strong></div></div>
            <div className="tt-total"><span>Estimated total</span><strong>${money(quote.totalCents)} <small>USD</small></strong></div>
            <p className="tt-price-note"><Icon name="shield"/> Authenticated backend operations calculate prices from trusted records. This sample quotation is illustrative.</p>
            <div className="tt-invoice-preview"><span className="tt-overline">SAMPLE INVOICE STATUS</span><strong>{stage==='MOCK_DRAFT'?'Sample preview ready':'No invoice created in this sample'}</strong><small>{stage==='MOCK_DRAFT'?'PREVIEW-ONLY · No provider invoice ID':'Create and send operations require a verified merchant approval'}</small><button disabled title="Payment not available in this UI preview">Payments disabled in sample mode</button></div>
          </aside>
        </div>
        <CommercialConflictReview />
        <div className="tt-bottom"><p role="status" aria-live="polite"><span className="tt-pulse"/> {notice}</p><button onClick={reset}><Icon name="reset"/> Reset simulation</button></div>
        <footer className="tt-footer"><span>TradeTrust AI · PayPal AI Hackathon 2026</span><span>LOCAL PROTOTYPE · NOT A REAL CHECKOUT</span></footer>
      </main>
    </div>
  );
}
