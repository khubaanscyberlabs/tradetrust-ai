/**
 * TradeTrust AI 09B-03-12-09C — dormant internal Workers AI binding bridge.
 * Not an HTTP handler. This is NOT a buyer authentication/authorization layer.
 * The caller MUST independently authorize merchant membership or dealroom access
 * before passing a quote selector. Do not publish a route for this function.
 *
 * A real AI binding can be invoked only by an explicit local-only execution gate.
 * No PayPal operations, payments, quotes writes or retries occur here.
 */
import { resolveTrustedNegotiationContext, type TrustedContextEnv } from './trusted-context.ts';
import { buildCloudflareNegotiationRequest, interpretCloudflareNegotiationAdvisory, type CloudflareAdvisoryResult } from './cloudflare-provider.ts';

type WorkerAiRun = Readonly<{
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
}>;
export type ControlledCloudflareEnv = TrustedContextEnv & Readonly<{
  TRADETRUST_CF_AI_WORKFLOW_MODE?: string;
  TRADETRUST_CF_AI_EXECUTION_MODE?: string;
  AI?: WorkerAiRun;
}>;
export type ControlledCloudflareSelection = Readonly<{
  merchantId: string;
  quoteId: string;
  revisionNo: number;
}>;
export type ControlledCloudflareResult = Readonly<{
  mode: 'INTERNAL_LOCAL_BINDING';
  merchantId: string;
  quoteId: string;
  revisionNo: number;
  quoteSha256: string;
  model: '@cf/google/gemma-4-26b-a4b-it';
  policyOrigin: 'SERVER_DEMO_CONFIG';
  advisory: CloudflareAdvisoryResult;
  providerCallAttempted: true;
  executableOfferAllowed: false;
  merchantApprovalRecorded: false;
  paymentInitiated: false;
}>;

const SELECTION_KEYS = 'merchantId|quoteId|revisionNo';
function deny(code: string): never { throw new Error(code); }
function exactSelection(value: unknown): value is ControlledCloudflareSelection {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join('|') === SELECTION_KEYS;
}

/**
 * DORMANT until explicitly configured by trusted local orchestration.
 * Never call from public routes, and never pass caller-controlled merchant ID
 * without an independent authorization check. The provider is never retried.
 */
export async function previewTrustedCloudflareViaBinding(
  env: ControlledCloudflareEnv | undefined,
  rawSelection: unknown,
  buyerMessage: unknown,
): Promise<ControlledCloudflareResult> {
  // Gate before D1 reads or AI calls. No accepted production/public mode.
  if (!env || env.TRADETRUST_CF_AI_WORKFLOW_MODE !== 'LOCAL_EXPLICIT_TEST_ONLY' ||
      env.TRADETRUST_CF_AI_EXECUTION_MODE !== 'LOCAL_EXPLICIT_TEST_ONLY' ||
      env.TRADETRUST_AI_CONTEXT_MODE !== 'LOCAL_SIMULATION' ||
      !env.AI || typeof env.AI.run !== 'function') {
    deny('TRADETRUST_CF_BINDING_DISABLED');
  }
  if (!exactSelection(rawSelection)) {
    deny('TRADETRUST_CF_BINDING_SELECTION_REJECTED');
  }
  // D1 SELECT restricted to latest snapshot, validating merchant, revision and SHA.
  const trusted = await resolveTrustedNegotiationContext(
    env, rawSelection.merchantId, rawSelection.quoteId, rawSelection.revisionNo,
  );
  if (trusted.revisionNo !== rawSelection.revisionNo ||
      trusted.executableOfferAllowed !== false || trusted.policyOrigin !== 'SERVER_DEMO_CONFIG') {
    deny('TRADETRUST_CF_BINDING_CONTEXT_REJECTED');
  }
  const built = buildCloudflareNegotiationRequest(trusted.context, buyerMessage);
  if (built.quoteIdentity.merchantId !== trusted.context.merchantId ||
      built.quoteIdentity.quoteId !== trusted.context.quoteId ||
      built.quoteIdentity.quoteSha256 !== trusted.context.quoteSha256) {
    deny('TRADETRUST_CF_BINDING_REQUEST_REJECTED');
  }

  let raw: unknown;
  let providerThrew = false;
  try {
    // Exactly one provider invocation. Rejected/busy/timeout outcomes are
    // uncertain: never retry inside this function or assume completion.
    raw = await env.AI.run(built.model, built.request, { rejectIfBusy: true });
  } catch {
    providerThrew = true;
    raw = null; // constant safe clarification; never expose upstream error.
  }
  const advisory = interpretCloudflareNegotiationAdvisory(
    raw, trusted.context.maxDiscountBps,
  );
  if (advisory.nonBinding !== true || advisory.executableOfferAllowed !== false ||
      advisory.merchantApprovalRecorded !== false || advisory.paymentInitiated !== false) {
    deny('TRADETRUST_CF_BINDING_ADVISORY_REJECTED');
  }
  // Fixed, sanitized diagnostic categories only. Never log upstream errors,
  // prompts, user content, model output, credentials, IDs, or monetary data.
  console.info(providerThrew ? 'TRADETRUST_CF_AI_DIAGNOSTIC=PROVIDER_EXCEPTION' :
    advisory.source === 'LOCAL_SAFE_FALLBACK' ?
      'TRADETRUST_CF_AI_DIAGNOSTIC=MODEL_OUTPUT_REJECTED' :
      'TRADETRUST_CF_AI_DIAGNOSTIC=MODEL_OUTPUT_ACCEPTED');
  return Object.freeze({
    mode: 'INTERNAL_LOCAL_BINDING' as const,
    merchantId: trusted.context.merchantId,
    quoteId: trusted.context.quoteId,
    revisionNo: trusted.revisionNo,
    quoteSha256: trusted.context.quoteSha256,
    model: built.model,
    policyOrigin: trusted.policyOrigin,
    advisory,
    providerCallAttempted: true as const,
    executableOfferAllowed: false as const,
    merchantApprovalRecorded: false as const,
    paymentInitiated: false as const,
  });
}
