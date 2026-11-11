/** 09P-07A — Read-only evidence for one already approved LOCAL demo quote.
 * Not general-purpose onboarding, PayPal, AI, quotation creation or approval.
 * Never enabled outside exact localhost LOCAL_SESSION configuration.
 */
import { authorizeMerchantApproval, type MerchantAuthEnvironment } from './auth/merchant-authorization.ts';
import { localConfigured, LOCAL_ORIGIN } from './auth/local-session.ts';

type Statement = {
  bind(...values: Array<string | number>): { first<T>(): Promise<T | null> };
};
type ReadDb = { prepare(sql: string): Statement };
type Env = MerchantAuthEnvironment & { DB?: ReadDb };
type Row = {
  approval_id: string;
  merchant_id: string;
  quote_id: string;
  revision_no: number;
  snapshot_sha256: string;
  snapshot_json: string;
  currency: string;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  total_cents: number;
};

const MERCHANT = 'merchant-local-demo';
const QUOTE = '21c50c14-fe6b-4c5f-9811-aee5306aa38c';
const HASH = '225b8ff7fb7f90ca06c80ce809409ee5d524590ce506b189c566c24bddbd5235';
const REVISION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...extra,
  }});
}

const SQL = `SELECT a.id AS approval_id, a.merchant_id, a.quote_id,
  a.revision_no, a.snapshot_sha256, r.snapshot_json, r.currency,
  r.subtotal_cents, r.discount_cents, r.shipping_cents, r.total_cents
FROM approvals a
JOIN quote_revisions r ON r.merchant_id=a.merchant_id
  AND r.quote_id=a.quote_id AND r.revision_no=a.revision_no
  AND r.snapshot_sha256=a.snapshot_sha256
WHERE a.merchant_id=? AND a.quote_id=? AND a.revision_no=?
  AND a.snapshot_sha256=?
  AND r.revision_no=(SELECT MAX(v.revision_no)
      FROM quote_revisions v WHERE v.merchant_id=a.merchant_id
        AND v.quote_id=a.quote_id)
LIMIT 1`;

export async function localDemoEvidenceEndpoint(
  request: Request,
  env: Env | undefined,
  readBody: (r: Request) => Promise<string>,
): Promise<Response> {
  if (!env || env.TRADETRUST_AUTH_MODE !== 'LOCAL_SESSION' ||
      !localConfigured(env) || !env.DB || new URL(request.url).origin !== LOCAL_ORIGIN) {
    return json(404, {error: 'not_found'});
  }
  if (request.method !== 'POST') return json(405, {error: 'method_not_allowed'}, {Allow:'POST'});
  if (request.headers.get('Origin') !== LOCAL_ORIGIN) return json(403, {error:'forbidden'});
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) {
    return json(415, {error:'unsupported_media_type'});
  }
  const size = request.headers.get('Content-Length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > 32)) {
    return json(413, {error:'body_too_large'});
  }
  // The current session and merchant OWNER/MANAGER role are verified by the
  // original authorization function. No browser-supplied identity is accepted.
  try { await authorizeMerchantApproval(request, env, MERCHANT); }
  catch { return json(403, {error:'forbidden'}); }

  try {
    const input = await readBody(request);
    if (input.length > 32 || input.trim() !== '{}') return json(400, {error:'invalid_request'});
  } catch { return json(400, {error:'invalid_request'}); }

  try {
    const row = await env.DB.prepare(SQL).bind(MERCHANT, QUOTE, String(REVISION), HASH).first<Row>();
    if (!row || !ID.test(row.approval_id) || row.merchant_id !== MERCHANT ||
        row.quote_id !== QUOTE || row.revision_no !== REVISION ||
        row.snapshot_sha256 !== HASH || row.currency !== 'USD' ||
        row.subtotal_cents !== 8400 || row.discount_cents !== 0 ||
        row.shipping_cents !== 2500 || row.total_cents !== 10900 ||
        typeof row.snapshot_json !== 'string') {
      return json(503, {error:'evidence_unavailable'});
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.snapshot_json));
    const digestHex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
    if (digestHex !== HASH) return json(503, {error:'evidence_unavailable'});
    const snapshot: unknown = JSON.parse(row.snapshot_json);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return json(503, {error:'evidence_unavailable'});
    }
    const s = snapshot as Record<string,unknown>;
    if (s.currency !== 'USD' || s.totalCents !== 10900 ||
        !Array.isArray(s.lines) || s.lines.length !== 1) {
      return json(503, {error:'evidence_unavailable'});
    }
    const line = s.lines[0] as Record<string,unknown>;
    if (!line || line.sku !== 'OUTFIT-01' || line.name !== 'Embroidered Outfit' ||
        line.quantity !== 2 || line.unitCents !== 4200 || line.lineCents !== 8400) {
      return json(503, {error:'evidence_unavailable'});
    }
    return json(200, {
      status: 'LOCAL_D1_APPROVED_DEMO',
      merchantId: MERCHANT, quoteId: QUOTE,
      revision: REVISION, snapshotSha256: HASH,
      approvalId: row.approval_id,
      currency: 'USD', subtotalCents: row.subtotal_cents,
      discountCents: row.discount_cents,
      shippingCents: row.shipping_cents,
      totalCents: row.total_cents,
      line: {sku:'OUTFIT-01', name:'Embroidered Outfit', quantity:2, unitCents:4200},
      providerInvoiceState: 'NOT_CHECKED_BY_THIS_ENDPOINT',
    });
  } catch {
    return json(503, {error:'evidence_unavailable'});
  }
}
