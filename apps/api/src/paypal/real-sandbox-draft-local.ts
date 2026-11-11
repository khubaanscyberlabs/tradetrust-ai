/**
 * LOCAL DEMO ONLY. Deliberately NOT registered in Worker HTTP router.
 * A separate release step, with explicit human authorization, is required
 * before calling this function with the real network transport.
 * PayPal Sandbox draft creation only; never send, pay, or invoke Live APIs.
 */
import { authorizeMerchantApproval } from '../auth/merchant-authorization.ts';
import { resolveLocalSandboxParties } from './trusted-sandbox-parties-local.ts';
import { prepareApprovedDraft, type DraftPreparationEnv } from './prepare-draft.ts';
import { claimPreparedDraft, finalizeVerifiedDraft } from './draft-operation-ledger.ts';
import { createSandboxDraftRealSandboxOnce, type SandboxDraftCreateEnv } from './sandbox-create-draft.ts';

export type RealSandboxLocalEnv = DraftPreparationEnv & SandboxDraftCreateEnv & Readonly<{
  TRADETRUST_AUTH_MODE?: string;
  TRADETRUST_SANDBOX_EXECUTION_MODE?: string;
}>;

export type RealSandboxBinding = Readonly<{ merchantId: string; approvalId: string }>;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOCAL_ORIGIN = 'http://127.0.0.1:8787';
function deny(): never { throw Error('PAYPAL_REAL_SANDBOX_LOCAL_DENIED'); }

/**
 * Never call as a direct public endpoint. The supplied Request must carry
 * the merchant's actual existing local-session cookie; identifiers alone
 * convey no authority. No caller-provided party emails are accepted.
 */
export async function executeOneRealSandboxDraftLocal(
  request: Request,
  env: RealSandboxLocalEnv | undefined,
  binding: RealSandboxBinding,
  transport: typeof fetch,
): Promise<Readonly<{status: 'DRAFT_CREATED'; invoiceId: string; operationId: string}>> {
  if (!request || !env || env.TRADETRUST_AUTH_MODE !== 'LOCAL_SESSION' ||
      env.PAYPAL_ENVIRONMENT !== 'SANDBOX' ||
      env.PAYPAL_DRAFT_CREATE_MODE !== 'SANDBOX_REAL_ONE_DRAFT' ||
      env.TRADETRUST_SANDBOX_EXECUTION_MODE !== 'LOCAL_SANDBOX_DRAFT_ONESHOT' ||
      !env.DB || typeof env.DB.prepare !== 'function' ||
      !binding || !ID.test(binding.merchantId ?? '') || !ID.test(binding.approvalId ?? '') ||
      typeof transport !== 'function' || request.method !== 'POST') deny();

  let url: URL;
  try { url = new URL(request.url); } catch { deny(); }
  if (url.origin !== LOCAL_ORIGIN || url.username || url.password ||
      request.headers.get('Origin') !== LOCAL_ORIGIN) deny();

  // Defense in depth: derive authorization from a verified local session.
  const authorized = await authorizeMerchantApproval(request, env, binding.merchantId);
  if (!authorized || authorized.merchantId !== binding.merchantId ||
      (authorized.role !== 'OWNER' && authorized.role !== 'MANAGER')) deny();

  // This is a D1 read of OPERATOR-REGISTERED test parties; not PayPal identity proof.
  const evidence = await resolveLocalSandboxParties(env.DB, authorized, binding.approvalId);
  if (!evidence || evidence.approvalId !== binding.approvalId ||
      evidence.parties.merchantId !== binding.merchantId ||
      evidence.paymentAuthorized !== false || evidence.paypalIdentityVerified !== false) deny();

  const prepared = await prepareApprovedDraft(request, env, {
    merchantId: binding.merchantId,
    approvalId: binding.approvalId,
    invoicerEmail: evidence.parties.invoicerEmail,
    invoicerBusinessName: evidence.parties.invoicerBusinessName,
    buyerEmail: evidence.parties.buyerEmail,
  });
  // A one-off demo execution is limited to the exact previously approved USD 109.
  if (prepared.status !== 'PREPARED' || prepared.paymentInitiated !== false ||
      prepared.expectedTotal.currency_code !== 'USD' ||
      prepared.expectedTotal.value !== '109.00') deny();

  // Irreversible D1 claim MUST precede the only possible external draft POST.
  const claimed = await claimPreparedDraft(env.DB, binding, prepared);
  try {
    // Invoicer email comes from the pinned operator-registered party record.
    const verified = await createSandboxDraftRealSandboxOnce(
      { ...env, PAYPAL_SANDBOX_MERCHANT_EMAIL: evidence.parties.invoicerEmail },
      claimed.ticket, transport,
    );
    return await finalizeVerifiedDraft(env.DB, binding, prepared, claimed, verified);
  } catch {
    // Any uncertainty leaves this same operation UNCERTAIN, never POST-retried.
    throw Error('PAYPAL_DRAFT_RECONCILIATION_REQUIRED');
  }
}
