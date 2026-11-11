/**
 * TradeTrust AI 09B-03-12-09B: trusted D1 quote -> Cloudflare request contract.
 * OFFLINE ONLY. This module accepts a *provided synthetic completion*, and has
 * no AI.run, fetch, payment, network, or HTTP entrypoint.
 *
 * The caller MUST establish tenant authorization independently before invoking.
 */
import { resolveTrustedNegotiationContext, type TrustedContextEnv } from './trusted-context.ts';
import {
  buildCloudflareNegotiationRequest,
  interpretCloudflareNegotiationAdvisory,
  type CloudflareAdvisoryResult,
} from './cloudflare-provider.ts';

export type OfflineCloudflareEnv = TrustedContextEnv & Readonly<{
  TRADETRUST_CF_AI_WORKFLOW_MODE?: string;
  AI?: unknown;
}>;

export type TrustedCloudflareSelection = Readonly<{
  merchantId: string;
  quoteId: string;
  revisionNo: number;
}>;

export type OfflineCloudflarePreview = Readonly<{
  mode: 'OFFLINE_MOCK';
  merchantId: string;
  quoteId: string;
  revisionNo: number;
  quoteSha256: string;
  model: '@cf/google/gemma-4-26b-a4b-it';
  policyOrigin: 'SERVER_DEMO_CONFIG';
  advisory: CloudflareAdvisoryResult;
  executableOfferAllowed: false;
  merchantApprovalRecorded: false;
  paymentInitiated: false;
}>;

const SELECTOR_KEYS = 'merchantId|quoteId|revisionNo';
function deny(code: string): never { throw new Error(code); }

/** A local rehearsal. The fourth argument is data, NOT a provider callback. */
export async function previewTrustedCloudflareOffline(
  env: OfflineCloudflareEnv | undefined,
  rawSelection: unknown,
  buyerMessage: unknown,
  syntheticProviderResponse: unknown,
): Promise<OfflineCloudflarePreview> {
  // A real Workers AI binding is forbidden here. No model call can originate
  // from the typed contract; the completion is externally supplied test data.
  if (!env || env.TRADETRUST_CF_AI_WORKFLOW_MODE !== 'OFFLINE_MOCK' ||
      env.TRADETRUST_AI_CONTEXT_MODE !== 'LOCAL_SIMULATION' ||
      env.AI !== undefined) {
    deny('TRADETRUST_CF_WORKFLOW_DISABLED');
  }
  if (rawSelection === null || typeof rawSelection !== 'object' ||
      Array.isArray(rawSelection) || Object.getPrototypeOf(rawSelection) !== Object.prototype ||
      Object.keys(rawSelection).sort().join('|') !== SELECTOR_KEYS) {
    deny('TRADETRUST_CF_WORKFLOW_SELECTION_REJECTED');
  }
  const selection = rawSelection as TrustedCloudflareSelection;
  // This resolves only the current, SHA-verified D1 quotation revision.
  // It is not caller authentication or authorization.
  const trusted = await resolveTrustedNegotiationContext(
    env, selection.merchantId, selection.quoteId, selection.revisionNo,
  );
  if (trusted.executableOfferAllowed !== false ||
      trusted.policyOrigin !== 'SERVER_DEMO_CONFIG' ||
      trusted.revisionNo !== selection.revisionNo) {
    deny('TRADETRUST_CF_WORKFLOW_CONTEXT_REJECTED');
  }
  const built = buildCloudflareNegotiationRequest(trusted.context, buyerMessage);
  if (built.quoteIdentity.merchantId !== trusted.context.merchantId ||
      built.quoteIdentity.quoteId !== trusted.context.quoteId ||
      built.quoteIdentity.quoteSha256 !== trusted.context.quoteSha256) {
    deny('TRADETRUST_CF_WORKFLOW_REQUEST_REJECTED');
  }
  // No call to a model occurs. The synthetic response remains untrusted data.
  const advisory = interpretCloudflareNegotiationAdvisory(
    syntheticProviderResponse, trusted.context.maxDiscountBps,
  );
  if (advisory.nonBinding !== true || advisory.executableOfferAllowed !== false ||
      advisory.merchantApprovalRecorded !== false || advisory.paymentInitiated !== false) {
    deny('TRADETRUST_CF_WORKFLOW_ADVISORY_REJECTED');
  }
  return Object.freeze({
    mode: 'OFFLINE_MOCK' as const,
    merchantId: trusted.context.merchantId,
    quoteId: trusted.context.quoteId,
    revisionNo: trusted.revisionNo,
    quoteSha256: trusted.context.quoteSha256,
    model: built.model,
    policyOrigin: trusted.policyOrigin,
    advisory,
    executableOfferAllowed: false as const,
    merchantApprovalRecorded: false as const,
    paymentInitiated: false as const,
  });
}
