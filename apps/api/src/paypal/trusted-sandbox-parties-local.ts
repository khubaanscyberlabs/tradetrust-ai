import type { AuthorizedMerchant } from '../auth/merchant-authorization.ts';
import type { TrustedSandboxParties } from './sandbox-execution-boundary.ts';

/**
 * Local-only, read-only lookup of operator-registered Sandbox test participants.
 * NOT a PayPal account-ownership check. NOT buyer consent or financial approval.
 * The caller MUST first produce AuthorizedMerchant through a verified Access
 * identity or an authenticated server-side LOCAL_SESSION. This does not
 * authorize client-supplied actor identities or introduce any HTTP route.
 * No PayPal, AI, fetch, or D1 writes occur here.
 */
export type PartyReadDb = Readonly<{
  prepare(sql: string): { bind(...values: string[]): { first<T>(): Promise<T | null> } };
}>;

export type LocalSandboxPartyEvidence = Readonly<{
  parties: TrustedSandboxParties;
  approvalId: string;
  quoteId: string;
  revisionNo: number;
  snapshotSha256: string;
  sourceAssurance: 'LOCAL_D1_OPERATOR_REGISTERED_NOT_PROVIDER_VERIFIED';
  paypalIdentityVerified: false;
  paymentAuthorized: false;
}>;

type Row = Readonly<{
  approval_id: string;
  merchant_id: string;
  quote_id: string;
  revision_no: number;
  snapshot_sha256: string;
  invoicer_email: string;
  invoicer_business_name: string;
  buyer_email: string;
  origin: string;
  actor_id: string;
  role: string;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
function deny(): never { throw Error('TRUSTED_SANDBOX_PARTY_LOOKUP_REJECTED'); }
function email(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 5 && value.length <= 254 &&
    EMAIL.test(value) && !value.includes('..') && !/[\r\n\u0000-\u001f\u007f]/.test(value);
}

const SQL = `
SELECT p.approval_id, p.merchant_id, p.quote_id, p.revision_no,
  p.snapshot_sha256, p.invoicer_email, p.invoicer_business_name,
  p.buyer_email, p.origin, mm.actor_id, mm.role
FROM sandbox_invoice_parties p
JOIN approvals a ON a.id = p.approval_id AND a.merchant_id = p.merchant_id
  AND a.quote_id = p.quote_id AND a.revision_no = p.revision_no
  AND a.snapshot_sha256 = p.snapshot_sha256
JOIN quote_revisions r ON r.quote_id = a.quote_id AND r.merchant_id = a.merchant_id
  AND r.revision_no = a.revision_no AND r.snapshot_sha256 = a.snapshot_sha256
JOIN merchant_memberships mm ON mm.merchant_id = p.merchant_id
  AND mm.actor_id = ? AND mm.status = 'ACTIVE' AND mm.role IN ('OWNER','MANAGER')
JOIN merchant_actors ma ON ma.id = mm.actor_id AND ma.status = 'ACTIVE'
  AND ma.provider IN ('CLOUDFLARE_ACCESS', 'LOCAL_SESSION')
WHERE p.merchant_id = ? AND p.approval_id = ?
  AND p.origin = 'LOCAL_OPERATOR_REGISTERED'
  AND r.revision_no = (SELECT MAX(z.revision_no) FROM quote_revisions z
    WHERE z.quote_id = p.quote_id AND z.merchant_id = p.merchant_id)
LIMIT 1`;

export async function resolveLocalSandboxParties(
  db: PartyReadDb,
  authorized: AuthorizedMerchant,
  approvalId: string,
): Promise<LocalSandboxPartyEvidence> {
  if (!db || typeof db.prepare !== 'function' ||
    !authorized || !ID.test(authorized.actorId ?? '') ||
    !ID.test(authorized.merchantId ?? '') ||
    (authorized.role !== 'OWNER' && authorized.role !== 'MANAGER') ||
    typeof approvalId !== 'string' || !ID.test(approvalId)) deny();

  let row: Row | null;
  try {
    row = await db.prepare(SQL).bind(
      authorized.actorId, authorized.merchantId, approvalId,
    ).first<Row>();
  } catch { throw Error('TRUSTED_SANDBOX_PARTY_LOOKUP_UNAVAILABLE'); }

  if (!row || row.merchant_id !== authorized.merchantId ||
    row.actor_id !== authorized.actorId || row.approval_id !== approvalId ||
    (row.role !== 'OWNER' && row.role !== 'MANAGER') ||
    !ID.test(row.quote_id) || !Number.isSafeInteger(row.revision_no) ||
    row.revision_no < 1 || !HASH.test(row.snapshot_sha256) ||
    row.origin !== 'LOCAL_OPERATOR_REGISTERED' ||
    !email(row.invoicer_email) || !email(row.buyer_email) ||
    row.invoicer_email.toLowerCase() === row.buyer_email.toLowerCase() ||
    typeof row.invoicer_business_name !== 'string' ||
    row.invoicer_business_name.length < 1 ||
    row.invoicer_business_name.length > 120 ||
    row.invoicer_business_name.trim() !== row.invoicer_business_name ||
    /[\u0000-\u001f\u007f]/.test(row.invoicer_business_name)) deny();

  return Object.freeze({
    parties: Object.freeze({
      source: 'TRUSTED_SERVER_RECORD' as const,
      merchantId: row.merchant_id,
      invoicerEmail: row.invoicer_email,
      invoicerBusinessName: row.invoicer_business_name,
      buyerEmail: row.buyer_email,
    }),
    approvalId,
    quoteId: row.quote_id,
    revisionNo: row.revision_no,
    snapshotSha256: row.snapshot_sha256,
    sourceAssurance: 'LOCAL_D1_OPERATOR_REGISTERED_NOT_PROVIDER_VERIFIED' as const,
    paypalIdentityVerified: false as const,
    paymentAuthorized: false as const,
  });
}
