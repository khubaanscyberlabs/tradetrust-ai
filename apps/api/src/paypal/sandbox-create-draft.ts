import type { SandboxCredentials } from './sandbox.ts';

/**
 * 09B-03-03: MOCK-ONLY Invoicing v2 draft creation HTTP adapter.
 *
 * Deliberately not registered with the Worker router. Transport injection is
 * mandatory; there is no fetch default. The only accepted write mode in this
 * milestone is MOCK_ONLY. A later reviewed orchestrator must:
 *  1. read trusted invoice parties from merchant/buyer records,
 *  2. authorize the actor and verify the persisted D1 approval,
 *  3. atomically claim PREPARED -> UNCERTAIN before any external POST,
 *  4. pass exactly the persisted request body digest/request ID,
 *  5. verify response and persist DRAFT_CREATED, or reconcile uncertainty.
 * No invoice sending or payment execution is implemented here.
 */

export type SandboxDraftCreateEnv = SandboxCredentials & {
  PAYPAL_DRAFT_CREATE_MODE?: string;
  PAYPAL_SANDBOX_MERCHANT_EMAIL?: string;
};

export type ClaimedDraftTicket = Readonly<{
  status: 'UNCERTAIN';
  paypalRequestId: string;
  requestBodySha256: string;
  invoiceNumber: string;
  expectedTotal: Readonly<{ currency_code: 'USD'; value: string }>;
  draftBody: unknown;
}>;

export type VerifiedSandboxDraft = Readonly<{
  invoiceId: string;
  invoiceNumber: string;
  currencyCode: 'USD';
  totalValue: string;
  status: 'DRAFT';
}>;

const BASE = 'https://api-m.sandbox.paypal.com';
const WRITE_SCOPE =
  'https://uri.paypal.com/services/invoicing/invoices/readwrite';

const LEGACY_INVOICING_SCOPE =
  'https://uri.paypal.com/services/invoicing';

/**
 * Accept only known invoice-creation-capable OAuth grants.
 * PayPal Sandbox may issue its documented general Invoicing
 * scope instead of the narrower OpenAPI readwrite scope.
 */
export function permitsPayPalDraftCreateScope(
  scopes: unknown,
): boolean {
  return typeof scopes === 'string' &&
    scopes.split(/\s+/).some(
      scope =>
        scope === WRITE_SCOPE ||
        scope === LEGACY_INVOICING_SCOPE
    );
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INVOICE_NUMBER = /^TT-[0-9a-f]{20}$/;
const INVOICE_ID = /^INV2-[A-Za-z0-9-]{8,120}$/;
const USD = /^(?:0|[1-9][0-9]{0,6})\.[0-9]{2}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return record(value[key]) ? value[key] as Record<string, unknown> : null;
}

function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value) &&
    !value.includes('..') && !/[\r\n]/.test(value);
}

function recipients(body: Record<string, unknown>): string | null {
  const list = body.primary_recipients;
  if (!Array.isArray(list) || list.length !== 1 || !record(list[0])) return null;
  const billing = nested(list[0], 'billing_info');
  return billing && validEmail(billing.email_address) ? billing.email_address : null;
}

function itemFields(item: unknown): { name: string; quantity: string; value: string } | null {
  if (!record(item) || typeof item.name !== 'string' || !item.name.trim() ||
      typeof item.quantity !== 'string' || !/^[1-9][0-9]*$/.test(item.quantity)) return null;
  const unit = nested(item, 'unit_amount');
  if (!unit || unit.currency_code !== 'USD' || typeof unit.value !== 'string' ||
      !USD.test(unit.value)) return null;
  return { name: item.name, quantity: item.quantity, value: unit.value };
}

function checkBody(body: unknown, ticket: ClaimedDraftTicket, merchantEmail: string): asserts body is Record<string, unknown> {
  if (!record(body)) throw Error('PAYPAL_DRAFT_TICKET_REJECTED');
  const detail = nested(body, 'detail');
  const invoicer = nested(body, 'invoicer');
  const config = nested(body, 'configuration');
  const partial = config && nested(config, 'partial_payment');
  const buyer = recipients(body);
  const amount = body.amount === undefined ? null : nested(body, 'amount');
  if (body.amount !== undefined && (!amount || amount.currency_code !== 'USD' ||
      amount.value !== ticket.expectedTotal.value)) {
    throw Error('PAYPAL_DRAFT_TICKET_REJECTED');
  }
  if (!detail || detail.invoice_number !== ticket.invoiceNumber ||
      detail.currency_code !== 'USD' ||
      !invoicer || !validEmail(invoicer.email_address) ||
      invoicer.email_address.toLowerCase() !== merchantEmail.toLowerCase() ||
      !buyer || buyer.toLowerCase() === merchantEmail.toLowerCase() ||
      !config || config.allow_tip !== false || !partial ||
      partial.allow_partial_payment !== false ||
      !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100 ||
      !body.items.every(item => itemFields(item) !== null)) {
    throw Error('PAYPAL_DRAFT_TICKET_REJECTED');
  }
}

async function verifyTicket(ticket: ClaimedDraftTicket, merchantEmail: string): Promise<string> {
  if (!ticket || ticket.status !== 'UNCERTAIN' ||
      !UUID_V4.test(ticket.paypalRequestId) ||
      !SHA256.test(ticket.requestBodySha256) ||
      !INVOICE_NUMBER.test(ticket.invoiceNumber) ||
      !record(ticket.expectedTotal) ||
      ticket.expectedTotal.currency_code !== 'USD' ||
      typeof ticket.expectedTotal.value !== 'string' ||
      !USD.test(ticket.expectedTotal.value) ||
      Number(ticket.expectedTotal.value.replace('.', '')) < 1 ||
      Number(ticket.expectedTotal.value.replace('.', '')) > 100000000) {
    throw Error('PAYPAL_DRAFT_TICKET_REJECTED');
  }

  checkBody(ticket.draftBody, ticket, merchantEmail);
  let bodyText: string;
  try {
    bodyText = JSON.stringify(ticket.draftBody);
  } catch {
    throw Error('PAYPAL_DRAFT_TICKET_REJECTED');
  }
  if (typeof bodyText !== 'string' || bodyText.length > 100000) {
    throw Error('PAYPAL_DRAFT_TICKET_REJECTED');
  }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bodyText));
  const digest = Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
  if (digest !== ticket.requestBodySha256) throw Error('PAYPAL_DRAFT_TICKET_REJECTED');
  return bodyText;
}

async function safeCall(transport: typeof fetch, path: string, init: RequestInit): Promise<Response> {
  try {
    return await transport(BASE + path, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw Error('PAYPAL_DRAFT_NETWORK_UNCERTAIN');
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw Error('PAYPAL_DRAFT_BAD_PROVIDER_RESPONSE');
  }
}

/**
 * Strictly mock-only until a separate D1 claim/reconciliation orchestration
 * is independently reviewed and explicitly enabled.
 */
export async function createSandboxDraftMockOnly(
  env: SandboxDraftCreateEnv,
  ticket: ClaimedDraftTicket,
  transport: typeof fetch,
): Promise<VerifiedSandboxDraft> {
  if (env?.PAYPAL_ENVIRONMENT !== 'SANDBOX') throw Error('PAYPAL_SANDBOX_ONLY');
  if (env.PAYPAL_DRAFT_CREATE_MODE !== 'MOCK_ONLY') throw Error('PAYPAL_DRAFT_CREATE_DISABLED');
  return createSandboxDraftCore(env, ticket, transport);
}

/** Explicitly gated real-Sandbox draft creation; no direct public route. */
export async function createSandboxDraftRealSandboxOnce(
  env: SandboxDraftCreateEnv & Readonly<{
    TRADETRUST_AUTH_MODE?: string;
    TRADETRUST_SANDBOX_EXECUTION_MODE?: string;
  }>,
  ticket: ClaimedDraftTicket,
  transport: typeof fetch,
): Promise<VerifiedSandboxDraft> {
  if (!env || env.PAYPAL_ENVIRONMENT !== 'SANDBOX' ||
      env.PAYPAL_DRAFT_CREATE_MODE !== 'SANDBOX_REAL_ONE_DRAFT' ||
      env.TRADETRUST_AUTH_MODE !== 'LOCAL_SESSION' ||
      env.TRADETRUST_SANDBOX_EXECUTION_MODE !== 'LOCAL_SANDBOX_DRAFT_ONESHOT') {
    throw Error('PAYPAL_DRAFT_REAL_SANDBOX_DISABLED');
  }
  return createSandboxDraftCore(env, ticket, transport);
}

async function createSandboxDraftCore(
  env: SandboxDraftCreateEnv,
  ticket: ClaimedDraftTicket,
  transport: typeof fetch,
): Promise<VerifiedSandboxDraft> {
  if (typeof transport !== 'function') throw Error('PAYPAL_DRAFT_TRANSPORT_REQUIRED');
  const id = env.PAYPAL_CLIENT_ID;
  const secret = env.PAYPAL_CLIENT_SECRET;
  const merchantEmail = env.PAYPAL_SANDBOX_MERCHANT_EMAIL;
  if (!id || id.includes(':') || /[\r\n]/.test(id) ||
      !secret || /[\r\n]/.test(secret) || !validEmail(merchantEmail)) {
    throw Error('PAYPAL_DRAFT_CREDENTIALS_INVALID');
  }
  const bodyText = await verifyTicket(ticket, merchantEmail);

  const oauth = await safeCall(transport, '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (oauth.status !== 200) throw Error('PAYPAL_DRAFT_OAUTH_REJECTED');
  const tokenResult = await json(oauth);
  if (!record(tokenResult) || tokenResult.token_type !== 'Bearer' ||
      typeof tokenResult.access_token !== 'string' || !tokenResult.access_token ||
      typeof tokenResult.scope !== 'string' ||
      !permitsPayPalDraftCreateScope(tokenResult.scope)) {
    throw Error('PAYPAL_DRAFT_OAUTH_SCOPE_REJECTED');
  }
  const bearer = tokenResult.access_token;

  // External POST is possible only through the explicitly provided transport;
  // the module is not registered as an application endpoint in this milestone.
  let created: Response;
  try {
    created = await safeCall(transport, '/v2/invoicing/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'PayPal-Request-Id': ticket.paypalRequestId,
        Prefer: 'return=representation',
      },
      body: bodyText,
    });
  } catch {
    throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED');
  }
  if (created.status !== 201) throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED');
  let creation: unknown;
  try { creation = await json(created); }
  catch { throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED'); }
  if (!record(creation) || typeof creation.id !== 'string' ||
      !INVOICE_ID.test(creation.id)) {
    throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED');
  }
  const invoiceId = creation.id;
  let fetched: Response;
  try {
    fetched = await safeCall(
      transport,
      `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`,
      { method: 'GET', headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
      } },
    );
  } catch {
    throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED');
  }
  if (fetched.status !== 200) throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED');
  let full: unknown;
  try { full = await json(fetched); }
  catch { throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED'); }
  if (!record(full) || full.id !== invoiceId || full.status !== 'DRAFT') {
    throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED');
  }
  const detail = nested(full, 'detail');
  const amount = nested(full, 'amount');
  const invoicer = nested(full, 'invoicer');
  const body = ticket.draftBody as Record<string, unknown>;
  const originalItems = body.items as unknown[];
  const returnedItems = full.items;
  if (!detail || detail.invoice_number !== ticket.invoiceNumber ||
      detail.currency_code !== 'USD' || !amount ||
      amount.currency_code !== 'USD' ||
      amount.value !== ticket.expectedTotal.value ||
      !invoicer || typeof invoicer.email_address !== 'string' ||
      invoicer.email_address.toLowerCase() !== merchantEmail.toLowerCase() ||
      recipients(full)?.toLowerCase() !== recipients(body)?.toLowerCase() ||
      !Array.isArray(returnedItems) || returnedItems.length !== originalItems.length ||
      !returnedItems.every((line, i) => {
        const actual = itemFields(line);
        const expected = itemFields(originalItems[i]);
        return actual !== null && expected !== null &&
          actual.name === expected.name &&
          actual.quantity === expected.quantity &&
          actual.value === expected.value;
      })) {
    throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED');
  }
  return Object.freeze({
    invoiceId,
    invoiceNumber: ticket.invoiceNumber,
    currencyCode: 'USD' as const,
    totalValue: ticket.expectedTotal.value,
    status: 'DRAFT' as const,
  });
}
