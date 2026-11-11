import type { ClaimedDraftTicket, VerifiedSandboxDraft } from './sandbox-create-draft.ts';

/**
 * TradeTrust AI 09B-03-04: INTERNAL LOCAL-D1 OPERATION TRANSITIONS.
 *
 * This module has NO network transport, OAuth, routing, scheduling, or PayPal calls.
 * Call only after prepareApprovedDraft has authenticated/authorized a signed human
 * and verified the actual persisted approval and quote revision.
 *
 * Claim is IRREVERSIBLE: PREPARED -> UNCERTAIN. The caller must not retry an
 * external POST after a crash/timeout. A separate reconciliation step is needed.
 * State changes are guarded by single-statement conditional updates and readback.
 */

type Statement = {
  bind(...values: Array<string | number>): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
};
export type DraftLedgerDb = { prepare(sql: string): Statement };

export type PreparedOperation = Readonly<{
  status: 'PREPARED';
  operationId: string;
  paypalRequestId: string;
  invoiceNumber: string;
  expectedTotal: Readonly<{ currency_code: 'USD'; value: string }>;
  draftBody: unknown;
  paymentInitiated: false;
}>;

export type OperationBinding = Readonly<{
  merchantId: string;
  approvalId: string;
}>;

export type ClaimedOperation = Readonly<{
  operationId: string;
  merchantId: string;
  approvalId: string;
  ticket: ClaimedDraftTicket;
}>;

type Row = {
  id: string; merchant_id: string; approval_id: string;
  quote_id: string; revision_no: number; snapshot_sha256: string;
  paypal_request_id: string; request_body_sha256: string;
  invoice_number: string; expected_total_cents: number; currency: string;
  status: string; paypal_invoice_id: string | null;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const NUMBER = /^TT-[a-f0-9]{20}$/;
const INVOICE_ID = /^INV2-[A-Za-z0-9-]{8,120}$/;
const USD = /^(?:0|[1-9][0-9]{0,6})\.[0-9]{2}$/;

const READ_SQL = `
 SELECT id, merchant_id, approval_id, quote_id, revision_no,
   snapshot_sha256, paypal_request_id, request_body_sha256,
   invoice_number, expected_total_cents, currency, status, paypal_invoice_id
 FROM paypal_draft_operations
 WHERE id = ? AND merchant_id = ? AND approval_id = ? LIMIT 1
`;

function denied(): never { throw Error('PAYPAL_DRAFT_LEDGER_REJECTED'); }
function uncertain(): never { throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED'); }

function cents(amount: unknown): number {
  if (typeof amount !== 'string' || !USD.test(amount)) denied();
  const value = Number(amount.replace('.', ''));
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000000) denied();
  return value;
}

async function sha256(bytes: string): Promise<string> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
  return [...new Uint8Array(raw)].map(v => v.toString(16).padStart(2, '0')).join('');
}

function validateBinding(binding: OperationBinding): void {
  if (!binding || !ID.test(binding.merchantId) || !ID.test(binding.approvalId)) denied();
}

function validateRow(row: Row | null, binding: OperationBinding,
  prepared: PreparedOperation, digest: string, total: number,
  status: 'PREPARED' | 'UNCERTAIN' | 'DRAFT_CREATED', invoiceId: string | null): void {
  if (!row || !UUID.test(row.id) || row.id !== prepared.operationId ||
    row.merchant_id !== binding.merchantId || row.approval_id !== binding.approvalId ||
    !ID.test(row.quote_id) || !Number.isSafeInteger(row.revision_no) || row.revision_no < 1 ||
    !HASH.test(row.snapshot_sha256) ||
    row.paypal_request_id !== prepared.paypalRequestId ||
    row.request_body_sha256 !== digest ||
    row.invoice_number !== prepared.invoiceNumber || row.expected_total_cents !== total ||
    row.currency !== 'USD' || row.status !== status || row.paypal_invoice_id !== invoiceId) {
    denied();
  }
}

async function read(db: DraftLedgerDb, binding: OperationBinding, id: string): Promise<Row | null> {
  return db.prepare(READ_SQL).bind(id, binding.merchantId, binding.approvalId).first<Row>();
}

/** Only transitions a previously prepared, persisted operation. Never issues an HTTP request. */
export async function claimPreparedDraft(
  db: DraftLedgerDb, binding: OperationBinding, prepared: PreparedOperation,
): Promise<ClaimedOperation> {
  if (!db || typeof db.prepare !== 'function') denied();
  validateBinding(binding);
  if (!prepared || prepared.status !== 'PREPARED' || prepared.paymentInitiated !== false ||
    !UUID.test(prepared.operationId) || !UUID.test(prepared.paypalRequestId) ||
    !NUMBER.test(prepared.invoiceNumber) || !prepared.expectedTotal ||
    prepared.expectedTotal.currency_code !== 'USD') denied();
  const total = cents(prepared.expectedTotal.value);
  let body: string;
  try { body = JSON.stringify(prepared.draftBody); }
  catch { denied(); }
  if (typeof body !== 'string' || body.length > 100000 || body.length < 20) denied();
  const digest = await sha256(body);
  let existing: Row | null;
  try { existing = await read(db, binding, prepared.operationId); }
  catch { throw Error('PAYPAL_DRAFT_LEDGER_UNAVAILABLE'); }
  validateRow(existing, binding, prepared, digest, total, 'PREPARED', null);

  // Atomic D1 compare-and-swap. Match the immutable financial identity AND
  // still-existing approval/revision before claiming the external operation.
  const claimSql = `
    UPDATE paypal_draft_operations
    SET status = 'UNCERTAIN', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND merchant_id = ? AND approval_id = ?
      AND paypal_request_id = ? AND request_body_sha256 = ?
      AND invoice_number = ? AND expected_total_cents = ? AND currency = 'USD'
      AND status = 'PREPARED' AND paypal_invoice_id IS NULL
      AND EXISTS (
        SELECT 1 FROM approvals a INNER JOIN quote_revisions r
          ON r.quote_id = a.quote_id AND r.merchant_id = a.merchant_id
          AND r.revision_no = a.revision_no AND r.snapshot_sha256 = a.snapshot_sha256
        WHERE a.id = paypal_draft_operations.approval_id
          AND a.merchant_id = paypal_draft_operations.merchant_id
          AND a.quote_id = paypal_draft_operations.quote_id
          AND a.revision_no = paypal_draft_operations.revision_no
          AND a.snapshot_sha256 = paypal_draft_operations.snapshot_sha256
          AND r.total_cents = paypal_draft_operations.expected_total_cents
          AND r.revision_no = (
            SELECT MAX(z.revision_no) FROM quote_revisions z
            WHERE z.quote_id = a.quote_id AND z.merchant_id = a.merchant_id
          )
      )
  `;
  try {
    const result = await db.prepare(claimSql).bind(
      prepared.operationId, binding.merchantId, binding.approvalId,
      prepared.paypalRequestId, digest, prepared.invoiceNumber, total,
    ).run();
    if (result?.success !== true || result.meta?.changes !== 1) uncertain();
    const row = await read(db, binding, prepared.operationId);
    validateRow(row, binding, prepared, digest, total, 'UNCERTAIN', null);
  } catch { uncertain(); }

  // Detached JSON clone prevents a caller from altering ticket.body after claim.
  const frozenBody: unknown = JSON.parse(body);
  return Object.freeze({
    operationId: prepared.operationId,
    merchantId: binding.merchantId,
    approvalId: binding.approvalId,
    ticket: Object.freeze({
      status: 'UNCERTAIN' as const, paypalRequestId: prepared.paypalRequestId,
      requestBodySha256: digest, invoiceNumber: prepared.invoiceNumber,
      expectedTotal: Object.freeze({ currency_code: 'USD' as const, value: prepared.expectedTotal.value }),
      draftBody: frozenBody,
    }),
  });
}

/**
 * Persist only an externally verified DRAFT, after the claim completed.
 * No retry of a failed/ambiguous external operation is attempted here.
 */
export async function finalizeVerifiedDraft(
  db: DraftLedgerDb, binding: OperationBinding,
  prepared: PreparedOperation, claim: ClaimedOperation,
  verified: VerifiedSandboxDraft,
): Promise<Readonly<{ status: 'DRAFT_CREATED'; invoiceId: string; operationId: string }>> {
  if (!db || typeof db.prepare !== 'function') denied();
  validateBinding(binding);
  if (!claim || claim.operationId !== prepared?.operationId ||
    claim.merchantId !== binding.merchantId || claim.approvalId !== binding.approvalId ||
    !claim.ticket || claim.ticket.status !== 'UNCERTAIN' ||
    claim.ticket.paypalRequestId !== prepared.paypalRequestId ||
    !HASH.test(claim.ticket.requestBodySha256) ||
    claim.ticket.invoiceNumber !== prepared.invoiceNumber ||
    claim.ticket.expectedTotal.value !== prepared.expectedTotal.value ||
    !verified || verified.status !== 'DRAFT' ||
    !INVOICE_ID.test(verified.invoiceId) ||
    verified.invoiceNumber !== prepared.invoiceNumber ||
    verified.currencyCode !== 'USD' ||
    verified.totalValue !== prepared.expectedTotal.value) denied();
  const total = cents(prepared.expectedTotal.value);
  let row: Row | null;
  try { row = await read(db, binding, prepared.operationId); }
  catch { uncertain(); }
  try {
    validateRow(row, binding, prepared, claim.ticket.requestBodySha256,
      total, 'UNCERTAIN', null);
  } catch { uncertain(); }
  try {
    const result = await db.prepare(`
      UPDATE paypal_draft_operations
      SET status = 'DRAFT_CREATED', paypal_invoice_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND merchant_id = ? AND approval_id = ?
        AND paypal_request_id = ? AND request_body_sha256 = ?
        AND invoice_number = ? AND expected_total_cents = ? AND currency = 'USD'
        AND status = 'UNCERTAIN' AND paypal_invoice_id IS NULL
    `).bind(
      verified.invoiceId, prepared.operationId, binding.merchantId,
      binding.approvalId, prepared.paypalRequestId,
      claim.ticket.requestBodySha256, prepared.invoiceNumber, total,
    ).run();
    if (result?.success !== true || result.meta?.changes !== 1) uncertain();
    const final = await read(db, binding, prepared.operationId);
    validateRow(final, binding, prepared, claim.ticket.requestBodySha256,
      total, 'DRAFT_CREATED', verified.invoiceId);
  } catch { uncertain(); }
  return Object.freeze({
    status: 'DRAFT_CREATED' as const,
    invoiceId: verified.invoiceId,
    operationId: prepared.operationId,
  });
}
