import type { JWTVerifyGetKey } from 'jose';
import type {LocalSessionConfig} from '../auth/local-session.ts';
import { authorizeMerchantApproval } from '../auth/merchant-authorization.ts';
import type { AccessConfig } from '../auth/access-identity.ts';
import { composeDraftRequest } from './draft-request.ts';

type Row = {
  id: string;
  merchant_id: string;
  quote_id: string;
  revision_no: number;
  snapshot_sha256: string;
  currency: string;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  total_cents: number;
  snapshot_json: string;
};

type Operation = {
  id: string;
  merchant_id: string;
  approval_id: string;
  quote_id: string;
  revision_no: number;
  snapshot_sha256: string;
  request_body_sha256: string;
  paypal_request_id: string;
  invoice_number: string;
  expected_total_cents: number;
  currency: string;
  status: string;
  paypal_invoice_id: string | null;
};

type Statement = {
  bind(...values: Array<string | number>): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
};

type DraftDb = {
  prepare(sql: string): Statement;
};

export type DraftPreparationEnv = AccessConfig & LocalSessionConfig & {
  DB?: DraftDb;
};

export type DraftPreparationInput = Readonly<{
  merchantId: string;
  approvalId: string;
  invoicerEmail: string;
  invoicerBusinessName: string;
  buyerEmail: string;
}>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const KEYS = 'approvalId|buyerEmail|invoicerBusinessName|invoicerEmail|merchantId';

const APPROVAL_SQL = `
  SELECT a.id, a.merchant_id, a.quote_id,
    a.revision_no, a.snapshot_sha256,
    r.currency, r.subtotal_cents, r.discount_cents,
    r.shipping_cents, r.total_cents, r.snapshot_json
  FROM approvals a
  INNER JOIN quote_revisions r
    ON r.quote_id = a.quote_id
    AND r.merchant_id = a.merchant_id
    AND r.revision_no = a.revision_no
    AND r.snapshot_sha256 = a.snapshot_sha256
  WHERE a.id = ? AND a.merchant_id = ?
  LIMIT 1
`;

const OPERATION_SQL = `
  SELECT id, merchant_id, approval_id, quote_id,
    revision_no, snapshot_sha256, request_body_sha256,
    paypal_request_id, invoice_number, expected_total_cents,
    currency, status, paypal_invoice_id
  FROM paypal_draft_operations WHERE approval_id = ? LIMIT 1
`;

function invalid(): never {
  throw Error('PAYPAL_DRAFT_PREPARATION_INVALID');
}

async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), v => v.toString(16).padStart(2, '0')).join('');
}

function parseInput(raw: unknown): DraftPreparationInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const input = raw as Record<string, unknown>;
  if (
    Object.keys(input).sort().join('|') !== KEYS ||
    typeof input.merchantId !== 'string' || !IDENTIFIER.test(input.merchantId) ||
    typeof input.approvalId !== 'string' || !IDENTIFIER.test(input.approvalId) ||
    typeof input.invoicerEmail !== 'string' ||
    typeof input.invoicerBusinessName !== 'string' ||
    typeof input.buyerEmail !== 'string'
  ) invalid();
  return input as DraftPreparationInput;
}

function validateOperation(
  row: Operation,
  expected: {
    merchantId: string;
    approvalId: string;
    quoteId: string;
    revision: number;
    snapshot: string;
    requestDigest: string;
    invoiceNumber: string;
    totalCents: number;
  },
): void {
  if (
    !row || !UUID_V4.test(row.id) || !UUID_V4.test(row.paypal_request_id) ||
    row.merchant_id !== expected.merchantId ||
    row.approval_id !== expected.approvalId ||
    row.quote_id !== expected.quoteId ||
    row.revision_no !== expected.revision ||
    row.snapshot_sha256 !== expected.snapshot ||
    !HASH.test(row.request_body_sha256) ||
    row.request_body_sha256 !== expected.requestDigest ||
    row.invoice_number !== expected.invoiceNumber ||
    row.currency !== 'USD' ||
    row.expected_total_cents !== expected.totalCents
  ) {
    throw Error('PAYPAL_DRAFT_OPERATION_CONFLICT');
  }
  if (row.status === 'UNCERTAIN') {
    throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED');
  }
  if (row.status === 'DRAFT_CREATED') {
    throw Error('PAYPAL_DRAFT_ALREADY_CREATED');
  }
  if (row.status !== 'PREPARED' || row.paypal_invoice_id !== null) {
    throw Error('PAYPAL_DRAFT_OPERATION_CONFLICT');
  }
}

/**
 * Internal-only. Verified human membership and persisted approval are required.
 * Does not call PayPal. Buyer/invoicer values must be sourced from trusted
 * onboarding records before enabling a merchant-facing integration.
 */
export async function prepareApprovedDraft(
  request: Request,
  env: DraftPreparationEnv | undefined,
  raw: unknown,
  testKeyset?: JWTVerifyGetKey,
) {
  const input = parseInput(raw);
  const db = env?.DB;
  if (!db || typeof db.prepare !== 'function') throw Error('PAYPAL_DRAFT_UNAVAILABLE');

  await authorizeMerchantApproval(request, env, input.merchantId, testKeyset);

  let approved: Row | null;
  try {
    approved = await db.prepare(APPROVAL_SQL)
      .bind(input.approvalId, input.merchantId)
      .first<Row>();
  } catch {
    throw Error('PAYPAL_DRAFT_UNAVAILABLE');
  }
  if (!approved) throw Error('PAYPAL_APPROVAL_NOT_FOUND');
  const trustedApprovalId = approved.id;

  const composed = await composeDraftRequest({
    merchantId: input.merchantId,
    approval: {
      id: approved.id,
      merchant_id: approved.merchant_id,
      quote_id: approved.quote_id,
      revision_no: approved.revision_no,
      snapshot_sha256: approved.snapshot_sha256,
    },
    stored: {
      quote_id: approved.quote_id,
      currency: approved.currency,
      subtotal_cents: approved.subtotal_cents,
      discount_cents: approved.discount_cents,
      shipping_cents: approved.shipping_cents,
      total_cents: approved.total_cents,
      snapshot_json: approved.snapshot_json,
      snapshot_sha256: approved.snapshot_sha256,
    },
    invoicerEmail: input.invoicerEmail,
    invoicerBusinessName: input.invoicerBusinessName,
    buyerEmail: input.buyerEmail,
  });

  const decimal = composed.expectedTotal.value;
  if (!/^\d{1,7}\.\d{2}$/.test(decimal)) invalid();
  const totalCents = Number(decimal.replace('.', ''));
  if (totalCents !== approved.total_cents) invalid();

  const requestDigest = await digest(JSON.stringify(composed.draftBody));
  const expected = {
    merchantId: input.merchantId,
    approvalId: approved.id,
    quoteId: approved.quote_id,
    revision: approved.revision_no,
    snapshot: approved.snapshot_sha256,
    requestDigest,
    invoiceNumber: composed.invoiceNumber,
    totalCents,
  };

  const find = async () => db.prepare(OPERATION_SQL)
    .bind(trustedApprovalId).first<Operation>();

  let existing: Operation | null;
  try { existing = await find(); }
  catch { throw Error('PAYPAL_DRAFT_UNAVAILABLE'); }

  if (existing) {
    validateOperation(existing, expected);
    return Object.freeze({
      status: 'PREPARED' as const, replayed: true,
      operationId: existing.id,
      paypalRequestId: existing.paypal_request_id,
      invoiceNumber: composed.invoiceNumber,
      expectedTotal: composed.expectedTotal,
      draftBody: composed.draftBody,
      paymentInitiated: false as const,
    });
  }

  const operationId = crypto.randomUUID();
  const paypalRequestId = crypto.randomUUID();
  try {
    const result = await db.prepare(`
      INSERT INTO paypal_draft_operations(
        id, approval_id, merchant_id, quote_id,
        revision_no, snapshot_sha256, request_body_sha256,
        paypal_request_id, invoice_number,
        expected_total_cents, currency
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      operationId, approved.id, input.merchantId, approved.quote_id,
      approved.revision_no, approved.snapshot_sha256, requestDigest,
      paypalRequestId, composed.invoiceNumber, totalCents, 'USD',
    ).run();
    if (result?.success !== true) throw Error('PAYPAL_DRAFT_INSERT_UNCONFIRMED');
  } catch {
    // A simultaneous identical request may have won the unique approval key.
    let recovered: Operation | null;
    try { recovered = await find(); }
    catch { throw Error('PAYPAL_DRAFT_OUTCOME_UNCERTAIN'); }
    if (!recovered) throw Error('PAYPAL_DRAFT_OUTCOME_UNCERTAIN');
    validateOperation(recovered, expected);
    return Object.freeze({
      status: 'PREPARED' as const, replayed: true,
      operationId: recovered.id,
      paypalRequestId: recovered.paypal_request_id,
      invoiceNumber: composed.invoiceNumber,
      expectedTotal: composed.expectedTotal,
      draftBody: composed.draftBody,
      paymentInitiated: false as const,
    });
  }

  let persisted: Operation | null;
  try { persisted = await find(); }
  catch { throw Error('PAYPAL_DRAFT_OUTCOME_UNCERTAIN'); }
  if (!persisted) throw Error('PAYPAL_DRAFT_OUTCOME_UNCERTAIN');
  validateOperation(persisted, expected);
  if (persisted.id !== operationId || persisted.paypal_request_id !== paypalRequestId) {
    throw Error('PAYPAL_DRAFT_OUTCOME_UNCERTAIN');
  }

  return Object.freeze({
    status: 'PREPARED' as const, replayed: false,
    operationId,
    paypalRequestId,
    invoiceNumber: composed.invoiceNumber,
    expectedTotal: composed.expectedTotal,
    draftBody: composed.draftBody,
    paymentInitiated: false as const,
  });
}
