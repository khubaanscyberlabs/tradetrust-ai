import { useState, type FormEvent } from 'react';

type EvidenceRef = Readonly<{
  merchantId:string; quoteId:string; revision:number; snapshotSha256:string;
  totalCents:number; currency:'USD';
}>;
type Preview = Readonly<{
  mode:'LOCAL_APPROVED_AI_CONTEXT_PREVIEW';
  merchantId:string; quoteId:string; revisionNo:number; quoteSha256:string;
  currency:'USD'; totalCents:number;
  model:'@cf/google/gemma-4-26b-a4b-it';
  policyOrigin:'SERVER_DEMO_CONFIG'; maxDemoDiscountBps:number;
  approvedQuoteVerified:true; contextPrepared:true;
  actualModelInference:false; providerCallAttempted:false;
  executableOfferAllowed:false; merchantApprovalRecorded:false; paymentInitiated:false;
}>;
export default function AuthorizedAiContextPreview({evidence}:{evidence:EvidenceRef}) {
  const [message,setMessage] = useState('Please clarify shipping responsibility and the delivery date.');
  const [result,setResult] = useState<Preview|null>(null);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('No Workers AI call has been authorized or made here.');
  async function inspect(event:FormEvent<HTMLFormElement>):Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setResult(null);
    try {
      const response = await fetch('/api/merchant/ai-context-preview',{
        method:'POST', credentials:'same-origin', cache:'no-store',
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({buyerMessage:message}),
      });
      if (!response.ok) throw Error(response.status===403 ?
        'Session expired or merchant access denied.' : 'Trusted AI context preview unavailable.');
      const raw:unknown = await response.json();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Untrusted context response.');
      const d = raw as Preview;
      if (d.mode !== 'LOCAL_APPROVED_AI_CONTEXT_PREVIEW' ||
          d.merchantId !== evidence.merchantId || d.quoteId !== evidence.quoteId ||
          d.revisionNo !== evidence.revision || d.quoteSha256 !== evidence.snapshotSha256 ||
          d.totalCents !== evidence.totalCents || d.currency !== evidence.currency ||
          d.model !== '@cf/google/gemma-4-26b-a4b-it' ||
          d.policyOrigin !== 'SERVER_DEMO_CONFIG' ||
          !Number.isSafeInteger(d.maxDemoDiscountBps) || d.maxDemoDiscountBps<0 ||
          d.maxDemoDiscountBps>500 || d.approvedQuoteVerified !== true ||
          d.contextPrepared !== true || d.actualModelInference !== false ||
          d.providerCallAttempted !== false || d.executableOfferAllowed !== false ||
          d.merchantApprovalRecorded !== false || d.paymentInitiated !== false) {
        throw Error('AI context verification failed.');
      }
      setResult(d);
      setNotice('Approved D1 quote context prepared locally. No model inference performed.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to prepare context.');
    } finally { setBusy(false); }
  }
  return <section style={{borderTop:'1px solid currentColor',marginTop:'1.25rem',paddingTop:'1rem'}}
    aria-label="Authenticated AI context readiness">
    <span className="tt-overline">09P-09B · AUTHENTICATED AI REQUEST READINESS</span>
    <h3>Prepare AI advisory inputs</h3>
    <p className="tt-muted">Read-only trusted context preview. It does not run a model or create another approval, invoice, or payment.</p>
    <form onSubmit={inspect}>
      <label htmlFor="tt-ai-buyer-message">Buyer message</label>
      <textarea id="tt-ai-buyer-message" rows={3} maxLength={500} value={message}
        onChange={e=>{setMessage(e.target.value);setResult(null);}}
        style={{display:'block',width:'100%',margin:'0.5rem 0'}} disabled={busy}/>
      <button type="submit" disabled={busy}>
        {busy?'Verifying approved context…':'Preview AI request context'}
      </button>
    </form>
    {result && <div role="status" style={{marginTop:'1rem'}}>
      <strong>Approved D1 context prepared — USD ${(result.totalCents/100).toFixed(2)}</strong>
      <p className="tt-muted">Model planned: {result.model}. Demo discount ceiling: {result.maxDemoDiscountBps/100}%. No Workers AI call.</p>
    </div>}
    <p className="tt-muted" role="status" aria-live="polite">{notice}</p>
  </section>;
}
