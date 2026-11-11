import { useState, type FormEvent } from 'react';
import ProtectedTermsReview from './ProtectedTermsReview';
import AuthorizedAiContextPreview from './AuthorizedAiContextPreview';

type Evidence = {
  status: 'LOCAL_D1_APPROVED_DEMO';
  merchantId: string;
  quoteId: string;
  revision: number;
  snapshotSha256: string;
  approvalId: string;
  currency: 'USD';
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  line: { sku: string; name: string; quantity: number; unitCents: number };
  providerInvoiceState: 'NOT_CHECKED_BY_THIS_ENDPOINT';
};

const box = {padding: '1rem', marginBottom: '1.25rem', border: '1px solid currentColor', borderRadius: '12px'} as const;
const field = {display: 'block', width: '100%', padding: '0.65rem', marginTop: '0.5rem', marginBottom: '0.75rem'} as const;
const cash = (n: number) => (n / 100).toFixed(2);

/** Local-only merchant evidence. Credentials are never persisted in browser storage. */
export default function VerifiedMerchantPanel() {
  const [credential, setCredential] = useState('');
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Not signed in. Local demo credential required.');

  async function loadEvidence(): Promise<void> {
    const res = await fetch('/api/merchant/demo-evidence', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!res.ok) throw new Error(res.status === 403 ? 'Session expired or merchant access denied.' : 'Local D1 evidence is unavailable.');
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' ||
        (data as Evidence).status !== 'LOCAL_D1_APPROVED_DEMO' ||
        (data as Evidence).totalCents !== 10900 ||
        (data as Evidence).currency !== 'USD') throw new Error('Evidence response failed verification.');
    setEvidence(data as Evidence);
    setMessage('Authenticated local merchant evidence retrieved from D1.');
  }

  async function login(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const entered = credential;
    setCredential('');
    if (!/^[a-f0-9]{64}$/.test(entered)) {
      setMessage('Enter the 64-character local demo credential.');
      return;
    }
    setBusy(true);
    setEvidence(null);
    try {
      const res = await fetch('/api/local-auth/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({credential: entered}),
      });
      if (!res.ok) throw new Error('Local merchant login rejected.');
      await loadEvidence();
    } catch (error) {
      setEvidence(null);
      setMessage(error instanceof Error ? error.message : 'Local login unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function refresh(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try { await loadEvidence(); }
    catch (error) {
      setEvidence(null);
      setMessage(error instanceof Error ? error.message : 'Unable to verify session.');
    } finally { setBusy(false); }
  }

  async function logout(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/local-auth/logout', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!res.ok) throw new Error('Logout unconfirmed; try again.');
      setEvidence(null);
      setMessage('Signed out; server-side session revoked.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Logout unavailable.');
    } finally { setBusy(false); }
  }

  return (
    <section style={box} aria-label="Authenticated local merchant evidence">
      <span className="tt-overline">VERIFIED MERCHANT RECORD · LOCAL DEMO</span>
      <h3>Authenticated merchant record</h3>
      <p className="tt-muted">Separate from the simulated quote below. Sign in to inspect the existing USD 109 locally approved quote. This screen cannot approve again, create invoices, call AI, or initiate payment.</p>
      {!evidence ? (
        <form onSubmit={login} autoComplete="off">
          <label htmlFor="tt-local-credential">Private local demo credential</label>
          <input id="tt-local-credential" type="password" autoComplete="off"
            spellCheck={false} style={field} maxLength={64} value={credential}
            onChange={event => setCredential(event.target.value)}
            placeholder="64-character local credential" disabled={busy} />
          <button className="tt-primary" type="submit" disabled={busy}>
            {busy ? 'Checking local session…' : 'Sign in and read approved D1 quote'}
          </button>
          <p className="tt-muted">Enter the credential only on your own localhost browser. Never paste it into chat or commit it.</p>
        </form>
      ) : (
        <div>
          <p><strong>Merchant-approved local quote · {evidence.currency} ${cash(evidence.totalCents)}</strong></p>
          <dl className="tt-integrity-facts">
            <div><dt>Goods</dt><dd>${cash(evidence.subtotalCents)} · {evidence.line.quantity} × {evidence.line.name}</dd></div>
            <div><dt>Shipping</dt><dd>${cash(evidence.shippingCents)}</dd></div>
            <div><dt>Discount</dt><dd>${cash(evidence.discountCents)}</dd></div>
            <div><dt>Revision</dt><dd>{evidence.revision}</dd></div>
            <div><dt>Quote ID</dt><dd><code>{evidence.quoteId}</code></dd></div>
            <div><dt>Snapshot SHA-256</dt><dd><code style={{overflowWrap:'anywhere'}}>{evidence.snapshotSha256}</code></dd></div>
            <div><dt>Approval ID</dt><dd><code>{evidence.approvalId}</code></dd></div>
          </dl>
          <p className="tt-muted">Evidence sourced from an authenticated local D1 read. PayPal provider state was not checked.</p>
          <ProtectedTermsReview evidence={evidence} />
          <AuthorizedAiContextPreview evidence={evidence} />
          <div style={{display:'flex', gap:'0.75rem', flexWrap:'wrap'}}>
            <button type="button" onClick={refresh} disabled={busy}>Refresh evidence</button>
            <button type="button" onClick={logout} disabled={busy}>Sign out</button>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className="tt-muted">{message}</p>
    </section>
  );
}
