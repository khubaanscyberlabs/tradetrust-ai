/**
 * TradeTrust AI 09B-03-10: internal, local-only D1 quote-context resolver.
 *
 * The caller must obtain merchantId through an independently verified
 * merchant membership or buyer dealroom access mechanism. This resolver
 * does NOT authenticate the caller; never expose it directly as HTTP.
 *
 * Policy is a server-owned DEMONSTRATION ceiling only (<=500 basis points),
 * not a persisted merchant policy or permission to make an executable offer.
 * No global fetch, external AI, invoice creation or D1 mutations.
 */
import type { TrustedNegotiationContext } from './negotiation.ts';

type ReadStatement = {
  bind(...values: Array<string | number>): ReadStatement;
  first<T>(): Promise<T | null>;
};
type ReadDb = { prepare(sql: string): ReadStatement };

export type TrustedContextEnv = Readonly<{
  DB?: ReadDb;
  TRADETRUST_AI_CONTEXT_MODE?: string;
  TRADETRUST_AI_DEMO_POLICY_BPS?: string;
}>;
export type TrustedContextResult = Readonly<{
  context: TrustedNegotiationContext;
  revisionNo: number;
  policyOrigin: 'SERVER_DEMO_CONFIG';
  executableOfferAllowed: false;
}>;

type StoredRevision = {
  quote_id: string;
  merchant_id: string;
  revision_no: number;
  snapshot_sha256: string;
  currency: string;
  total_cents: number;
  snapshot_json: string;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const SELECT_LATEST = `
  SELECT r.quote_id, r.merchant_id, r.revision_no,
    r.snapshot_sha256, r.currency, r.total_cents, r.snapshot_json
  FROM quote_revisions r
  INNER JOIN quotes q
    ON q.id = r.quote_id AND q.merchant_id = r.merchant_id
  WHERE r.merchant_id = ? AND r.quote_id = ? AND r.revision_no = ?
    AND r.revision_no = (
      SELECT MAX(next_revision.revision_no)
      FROM quote_revisions next_revision
      WHERE next_revision.merchant_id = r.merchant_id
        AND next_revision.quote_id = r.quote_id
    )
  LIMIT 1
`;

function deny(code: string): never { throw new Error(code); }

/**
 * Internal-only: `merchantId` must be independently authorized at the call site.
 * The quoteId and revisionNo only select data; they cannot supply financials.
 */
export async function resolveTrustedNegotiationContext(
  env: TrustedContextEnv | undefined,
  merchantId: unknown,
  quoteId: unknown,
  revisionNo: unknown,
): Promise<TrustedContextResult> {
  if (!env || env.TRADETRUST_AI_CONTEXT_MODE !== 'LOCAL_SIMULATION' ||
    !env.DB || typeof env.DB.prepare !== 'function' ||
    typeof env.TRADETRUST_AI_DEMO_POLICY_BPS !== 'string' ||
    !/^(0|[1-9][0-9]{0,2})$/.test(env.TRADETRUST_AI_DEMO_POLICY_BPS)) {
    deny('TRADETRUST_AI_CONTEXT_DISABLED');
  }
  const policyBps = Number(env.TRADETRUST_AI_DEMO_POLICY_BPS);
  if (!Number.isSafeInteger(policyBps) || policyBps > 500) {
    deny('TRADETRUST_AI_CONTEXT_DISABLED');
  }
  if (typeof merchantId !== 'string' || !ID.test(merchantId) ||
    typeof quoteId !== 'string' || !ID.test(quoteId) ||
    !Number.isSafeInteger(revisionNo) || typeof revisionNo !== 'number' ||
    revisionNo < 1 || revisionNo > 2147483647) {
    deny('TRADETRUST_AI_CONTEXT_INPUT_INVALID');
  }
  let row: StoredRevision | null;
  try {
    row = await env.DB.prepare(SELECT_LATEST).bind(merchantId, quoteId, revisionNo)
      .first<StoredRevision>();
  } catch {
    deny('TRADETRUST_AI_CONTEXT_UNAVAILABLE');
  }
  if (!row) deny('TRADETRUST_AI_CONTEXT_NOT_FOUND');
  if (row.merchant_id !== merchantId || row.quote_id !== quoteId ||
    row.revision_no !== revisionNo || row.currency !== 'USD' ||
    typeof row.snapshot_sha256 !== 'string' || !SHA.test(row.snapshot_sha256) ||
    !Number.isSafeInteger(row.total_cents) || row.total_cents < 1 ||
    row.total_cents > 100000000 ||
    typeof row.snapshot_json !== 'string' ||
    row.snapshot_json.length < 2 || row.snapshot_json.length > 100000) {
    deny('TRADETRUST_AI_CONTEXT_CORRUPT');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(row.snapshot_json); }
  catch { deny('TRADETRUST_AI_CONTEXT_CORRUPT'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    deny('TRADETRUST_AI_CONTEXT_CORRUPT');
  }
  const digestBytes = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(row.snapshot_json),
  );
  const digest = [...new Uint8Array(digestBytes)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== row.snapshot_sha256) {
    deny('TRADETRUST_AI_CONTEXT_CORRUPT');
  }
  const context: TrustedNegotiationContext = Object.freeze({
    merchantId: row.merchant_id,
    quoteId: row.quote_id,
    quoteSha256: digest,
    currency: 'USD' as const,
    maxDiscountBps: policyBps,
  });
  return Object.freeze({
    context,
    revisionNo: row.revision_no,
    policyOrigin: 'SERVER_DEMO_CONFIG' as const,
    executableOfferAllowed: false as const,
  });
}
