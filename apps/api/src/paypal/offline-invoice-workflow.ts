import { prepareApprovedDraft, type DraftPreparationEnv } from './prepare-draft.ts';
import {
  claimPreparedDraft, finalizeVerifiedDraft,
  type DraftLedgerDb, type OperationBinding, type PreparedOperation,
} from './draft-operation-ledger.ts';
import {
  createSandboxDraftMockOnly,
  type SandboxDraftCreateEnv, type ClaimedDraftTicket,
} from './sandbox-create-draft.ts';

/**
 * 09B-03-05: DISCONNECTED OFFLINE invoice workflow.
 * No public endpoint, no global fetch and no real PayPal transport.
 * This is not permission to create or send a real invoice.
 *
 * The signed-human entrypoint first calls prepareApprovedDraft, which verifies
 * Access identity, merchant membership and D1 approval. Recipient and sender
 * values are sourced from explicit MOCK fixture configuration, not HTTP input.
 */
export type OfflineWorkflowEnv = DraftPreparationEnv & SandboxDraftCreateEnv & Readonly<{
  TRADETRUST_OFFLINE_SIMULATION?: string;
  TRADETRUST_MOCK_MERCHANT_ID?: string;
  TRADETRUST_MOCK_BUYER_EMAIL?: string;
  TRADETRUST_MOCK_MERCHANT_NAME?: string;
}>;

export type OfflineScenario = 'SUCCESS' | 'CREATE_TIMEOUT' | 'GET_WRONG_AMOUNT';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const BASE = 'https://api-m.sandbox.paypal.com';
const WRITE_SCOPE = 'https://uri.paypal.com/services/invoicing/invoices/readwrite';
const MOCK_INVOICE_ID = 'INV2-TRADETRUST-LOCAL-MOCK-0001';

function deny(): never { throw Error('TRADETRUST_OFFLINE_WORKFLOW_DENIED'); }

function preflight(env: OfflineWorkflowEnv, binding: OperationBinding): DraftLedgerDb {
  if (!env || env.TRADETRUST_OFFLINE_SIMULATION !== 'ENABLED_LOCAL_ONLY' ||
      env.PAYPAL_ENVIRONMENT !== 'SANDBOX' || env.PAYPAL_DRAFT_CREATE_MODE !== 'MOCK_ONLY' ||
      !binding || !ID.test(binding.merchantId) || !ID.test(binding.approvalId) ||
      env.TRADETRUST_MOCK_MERCHANT_ID !== binding.merchantId ||
      typeof env.PAYPAL_SANDBOX_MERCHANT_EMAIL !== 'string' ||
      !EMAIL.test(env.PAYPAL_SANDBOX_MERCHANT_EMAIL) ||
      env.PAYPAL_SANDBOX_MERCHANT_EMAIL.length > 254 ||
      env.PAYPAL_SANDBOX_MERCHANT_EMAIL.includes('..') ||
      typeof env.TRADETRUST_MOCK_BUYER_EMAIL !== 'string' ||
      !EMAIL.test(env.TRADETRUST_MOCK_BUYER_EMAIL) ||
      env.TRADETRUST_MOCK_BUYER_EMAIL.length > 254 ||
      env.TRADETRUST_MOCK_BUYER_EMAIL.includes('..') ||
      env.TRADETRUST_MOCK_BUYER_EMAIL.toLowerCase() ===
        env.PAYPAL_SANDBOX_MERCHANT_EMAIL.toLowerCase() ||
      typeof env.TRADETRUST_MOCK_MERCHANT_NAME !== 'string' ||
      env.TRADETRUST_MOCK_MERCHANT_NAME.trim() !== env.TRADETRUST_MOCK_MERCHANT_NAME ||
      env.TRADETRUST_MOCK_MERCHANT_NAME.length < 1 ||
      env.TRADETRUST_MOCK_MERCHANT_NAME.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(env.TRADETRUST_MOCK_MERCHANT_NAME) ||
      typeof env.PAYPAL_CLIENT_ID !== 'string' || !env.PAYPAL_CLIENT_ID ||
      env.PAYPAL_CLIENT_ID.includes(':') || /[\r\n]/.test(env.PAYPAL_CLIENT_ID) ||
      typeof env.PAYPAL_CLIENT_SECRET !== 'string' || !env.PAYPAL_CLIENT_SECRET ||
      /[\r\n]/.test(env.PAYPAL_CLIENT_SECRET) ||
      !env.DB || typeof env.DB.prepare !== 'function') deny();
  return env.DB;
}

// The returned transport is a closure over synthetic local responses.
// It never forwards a request to fetch, XMLHttpRequest, or any network API.
function makeOfflineTransport(ticket: ClaimedDraftTicket, scenario: OfflineScenario): typeof fetch {
  const body = ticket.draftBody as Record<string, unknown>;
  const invoicePath = '/v2/invoicing/invoices/' + MOCK_INVOICE_ID;
  const local: typeof fetch = async (input, init) => {
    if (typeof input !== 'string' || !input.startsWith(BASE + '/')) {
      throw Error('TRADETRUST_MOCK_TRANSPORT_REJECTED');
    }
    const url = new URL(input);
    if (url.origin !== BASE || url.search || url.hash || !init?.signal ||
        init.redirect !== 'error') throw Error('TRADETRUST_MOCK_TRANSPORT_REJECTED');
    if (url.pathname === '/v1/oauth2/token' && init.method === 'POST') {
      return new Response(JSON.stringify({
        token_type: 'Bearer', access_token: 'offline-test-token', scope: WRITE_SCOPE,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/v2/invoicing/invoices' && init.method === 'POST') {
      const requestHeaders = new Headers(init.headers);
      if (requestHeaders.get('PayPal-Request-Id') !== ticket.paypalRequestId ||
          init.body !== JSON.stringify(body)) {
        throw Error('TRADETRUST_MOCK_TRANSPORT_REJECTED');
      }
      if (scenario === 'CREATE_TIMEOUT') throw Error('OFFLINE_SYNTHETIC_TIMEOUT');
      return new Response(JSON.stringify({ id: MOCK_INVOICE_ID }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === invoicePath && init.method === 'GET') {
      const amount = scenario === 'GET_WRONG_AMOUNT' ? '1.00' : ticket.expectedTotal.value;
      return new Response(JSON.stringify({
        id: MOCK_INVOICE_ID, status: 'DRAFT',
        detail: body.detail,
        amount: { currency_code: 'USD', value: amount },
        invoicer: body.invoicer,
        primary_recipients: body.primary_recipients,
        items: body.items,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw Error('TRADETRUST_MOCK_TRANSPORT_REJECTED');
  };
  return local;
}

/**
 * Core offline orchestration. The PreparedOperation must come from the signed
 * human / persisted approval service. This function is restricted by local-only
 * configuration; using it as an HTTP route is explicitly forbidden.
 */
export async function executePreparedDraftOffline(
  db: DraftLedgerDb,
  binding: OperationBinding,
  prepared: PreparedOperation,
  env: OfflineWorkflowEnv,
  scenario: OfflineScenario = 'SUCCESS',
): Promise<Readonly<{ status: 'DRAFT_CREATED'; invoiceId: string; operationId: string }>> {
  if (!env || env.DB !== db) deny();
  preflight(env, binding);
  if (!['SUCCESS', 'CREATE_TIMEOUT', 'GET_WRONG_AMOUNT'].includes(scenario)) deny();
  const claim = await claimPreparedDraft(db, binding, prepared);
  // Status is permanently UNCERTAIN after this point if anything fails.
  // Do not retry this function with the same operation.
  let verified;
  try {
    verified = await createSandboxDraftMockOnly(
      env, claim.ticket, makeOfflineTransport(claim.ticket, scenario),
    );
  } catch {
    throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED');
  }
  return finalizeVerifiedDraft(db, binding, prepared, claim, verified);
}

/**
 * Internal signed-human entrypoint; all emails are mock fixture configuration,
 * never buyer-controlled HTTP input. Real buyer onboarding remains pending.
 */
export async function simulateApprovedDraftOffline(
  request: Request,
  env: OfflineWorkflowEnv,
  identifiers: Readonly<{ merchantId: string; approvalId: string }>,
): Promise<Readonly<{ status: 'DRAFT_CREATED'; invoiceId: string; operationId: string }>> {
  const db = preflight(env, identifiers);
  const prepared = await prepareApprovedDraft(request, env, {
    merchantId: identifiers.merchantId,
    approvalId: identifiers.approvalId,
    buyerEmail: env.TRADETRUST_MOCK_BUYER_EMAIL!,
    invoicerEmail: env.PAYPAL_SANDBOX_MERCHANT_EMAIL!,
    invoicerBusinessName: env.TRADETRUST_MOCK_MERCHANT_NAME!,
  });
  return executePreparedDraftOffline(db, identifiers, prepared, env);
}
