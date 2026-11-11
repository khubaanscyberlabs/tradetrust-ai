import type {
  ClaimedOperation, OperationBinding, PreparedOperation,
} from './draft-operation-ledger.ts';

/**
 * 09P-02: OFFLINE-ONLY, side-effect-free PayPal draft execution preflight.
 * This is not authorization, D1 verification, an outbound transport or a
 * PayPal confirmation. Callers must obtain an authenticated, authorized
 * persisted approval/claim and verified parties from trusted server records.
 * The provenance field is an assertion by the caller, not a security proof.
 * This module never calls fetch, D1, PayPal or external services.
 */
export type TrustedSandboxParties = Readonly<{
  source: 'TRUSTED_SERVER_RECORD';
  merchantId: string;
  invoicerEmail: string;
  invoicerBusinessName: string;
  buyerEmail: string;
}>;

export type OfflineSandboxBoundaryEnv = Readonly<{
  PAYPAL_ENVIRONMENT?: string;
  TRADETRUST_SANDBOX_EXECUTION_MODE?: string;
}>;

export type OfflineValidatedExecution = Readonly<{
  state: 'OFFLINE_VALIDATED_ONLY';
  merchantId: string;
  approvalId: string;
  operationId: string;
  paypalRequestId: string;
  invoiceNumber: string;
  requestBodySha256: string;
  total: Readonly<{ currency_code: 'USD'; value: string }>;
  networkAllowed: false;
  paymentInitiated: false;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const NUMBER = /^TT-[a-f0-9]{20}$/;
const MONEY = /^(?:0|[1-9][0-9]{0,6})\.[0-9]{2}$/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const PARTY_KEYS = 'buyerEmail|invoicerBusinessName|invoicerEmail|merchantId|source';

function deny(): never { throw Error('SANDBOX_EXECUTION_BOUNDARY_REJECTED'); }
function obj(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) deny();
  return value as Record<string, unknown>;
}
function email(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 5 && value.length <= 254 &&
    EMAIL.test(value) && !value.includes('..') && !/[\s\u0000-\u001f\u007f]/.test(value);
}
function money(value: unknown): value is string {
  return typeof value === 'string' && MONEY.test(value) &&
    Number(value.replace('.', '')) >= 1 && Number(value.replace('.', '')) <= 100000000;
}
async function hash(text: string): Promise<string> {
  const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(data)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Strictly validates already-authorized inputs; never acquires credentials or contacts PayPal. */
export async function validateSandboxExecutionOffline(input: Readonly<{
  env: OfflineSandboxBoundaryEnv;
  binding: OperationBinding;
  prepared: PreparedOperation;
  claimed: ClaimedOperation;
  parties: TrustedSandboxParties;
}>): Promise<OfflineValidatedExecution> {
  const x = obj(input);
  const env = obj(x.env);
  // Fail closed. No LIVE or network execution mode exists in this milestone.
  if (env.PAYPAL_ENVIRONMENT !== 'SANDBOX' ||
      env.TRADETRUST_SANDBOX_EXECUTION_MODE !== 'OFFLINE_VALIDATE_ONLY') deny();

  const binding = obj(x.binding);
  const prepared = obj(x.prepared);
  const claimed = obj(x.claimed);
  const ticket = obj(claimed.ticket);
  const parties = obj(x.parties);

  if (Object.keys(parties).sort().join('|') !== PARTY_KEYS ||
      parties.source !== 'TRUSTED_SERVER_RECORD' ||
      typeof binding.merchantId !== 'string' || !ID.test(binding.merchantId) ||
      typeof binding.approvalId !== 'string' || !ID.test(binding.approvalId) ||
      parties.merchantId !== binding.merchantId ||
      claimed.merchantId !== binding.merchantId ||
      claimed.approvalId !== binding.approvalId ||
      prepared.status !== 'PREPARED' || prepared.paymentInitiated !== false ||
      ticket.status !== 'UNCERTAIN' ||
      typeof prepared.operationId !== 'string' || !UUID.test(prepared.operationId) ||
      claimed.operationId !== prepared.operationId ||
      typeof prepared.paypalRequestId !== 'string' || !UUID.test(prepared.paypalRequestId) ||
      ticket.paypalRequestId !== prepared.paypalRequestId ||
      typeof prepared.invoiceNumber !== 'string' || !NUMBER.test(prepared.invoiceNumber) ||
      ticket.invoiceNumber !== prepared.invoiceNumber ||
      typeof ticket.requestBodySha256 !== 'string' || !HASH.test(ticket.requestBodySha256) ||
      !email(parties.invoicerEmail) || !email(parties.buyerEmail) ||
      parties.buyerEmail.toLowerCase() === parties.invoicerEmail.toLowerCase() ||
      typeof parties.invoicerBusinessName !== 'string' ||
      parties.invoicerBusinessName.length < 1 || parties.invoicerBusinessName.length > 120 ||
      parties.invoicerBusinessName.trim() !== parties.invoicerBusinessName ||
      /[\u0000-\u001f\u007f]/.test(parties.invoicerBusinessName)) deny();

  const expected = obj(prepared.expectedTotal);
  const claimedExpected = obj(ticket.expectedTotal);
  if (expected.currency_code !== 'USD' || claimedExpected.currency_code !== 'USD' ||
      !money(expected.value) || claimedExpected.value !== expected.value) deny();

  let bodyText: string;
  let preparedText: string;
  try {
    bodyText = JSON.stringify(ticket.draftBody);
    preparedText = JSON.stringify(prepared.draftBody);
  } catch { deny(); }
  if (typeof bodyText !== 'string' || bodyText.length < 20 || bodyText.length > 100000 ||
      bodyText !== preparedText || await hash(bodyText) !== ticket.requestBodySha256) deny();

  const body = obj(ticket.draftBody);
  const detail = obj(body.detail);
  const invoicer = obj(body.invoicer);
  const recipients = body.primary_recipients;
  if (!Array.isArray(recipients) || recipients.length !== 1) deny();
  const recipient = obj(recipients[0]);
  const billing = obj(recipient.billing_info);
  if (detail.invoice_number !== prepared.invoiceNumber || detail.currency_code !== 'USD' ||
      !email(invoicer.email_address) ||
      invoicer.email_address.toLowerCase() !== (parties.invoicerEmail as string).toLowerCase() ||
      invoicer.business_name !== parties.invoicerBusinessName ||
      !email(billing.email_address) ||
      billing.email_address.toLowerCase() !== (parties.buyerEmail as string).toLowerCase()) deny();

  if (body.amount !== undefined) {
    const amount = obj(body.amount);
    if (amount.currency_code !== 'USD' || amount.value !== expected.value) deny();
  }
  const config = obj(body.configuration);
  const partial = obj(config.partial_payment);
  if (config.allow_tip !== false || partial.allow_partial_payment !== false ||
      !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) deny();

  return Object.freeze({
    state: 'OFFLINE_VALIDATED_ONLY',
    merchantId: binding.merchantId as string,
    approvalId: binding.approvalId as string,
    operationId: prepared.operationId as string,
    paypalRequestId: prepared.paypalRequestId as string,
    invoiceNumber: prepared.invoiceNumber as string,
    requestBodySha256: ticket.requestBodySha256 as string,
    total: Object.freeze({ currency_code: 'USD' as const, value: expected.value as string }),
    networkAllowed: false as const,
    paymentInitiated: false as const,
  });
}
