/**
 * TradeTrust AI 09B-03-11 — local, internal D1-to-model simulation.
 *
 * No HTTP registration, no real transport, no D1 writes and no executable
 * financial offers. The caller MUST independently authorize merchantId
 * before invoking this function. Never expose its selector as a public API.
 */
import { resolveTrustedNegotiationContext, type TrustedContextEnv } from './trusted-context.ts';
import { requestNegotiationProvider, type ProviderEnv, type ProviderSuggestion } from './live-provider.ts';

export type InternalNegotiationEnv = TrustedContextEnv & ProviderEnv & Readonly<{
  TRADETRUST_AI_WORKFLOW_MODE?: string;
}>;

export type InternalQuoteSelection = Readonly<{
  merchantId: string;
  quoteId: string;
  revisionNo: number;
}>;

export type InternalNegotiationResult = Readonly<{
  mode: 'LOCAL_SIMULATION';
  merchantId: string;
  quoteId: string;
  revisionNo: number;
  quoteSha256: string;
  policyOrigin: 'SERVER_DEMO_CONFIG';
  suggestion: ProviderSuggestion;
  executableOfferAllowed: false;
  merchantApprovalRecorded: false;
  paymentInitiated: false;
}>;

const SELECTOR_KEYS = 'merchantId|quoteId|revisionNo';
function denied(code: string): never { throw Error(code); }

/** Takes internal, preauthorized selection ONLY. Never call from public HTTP. */
export async function simulateTrustedLocalNegotiation(
  env: InternalNegotiationEnv | undefined,
  rawSelection: unknown,
  buyerMessage: unknown,
  mockTransport?: typeof fetch,
): Promise<InternalNegotiationResult> {
  if (!env || env.TRADETRUST_AI_WORKFLOW_MODE !== 'LOCAL_SIMULATION' ||
    env.TRADETRUST_AI_CONTEXT_MODE !== 'LOCAL_SIMULATION' ||
    env.TRADETRUST_AI_MODE !== 'MOCK_TRANSPORT' ||
    env.TRADETRUST_AI_REAL_CALL_APPROVED !== undefined ||
    env.OPENAI_API_KEY !== 'test-only-not-a-real-key' ||
    typeof mockTransport !== 'function' || mockTransport === fetch) {
    denied('TRADETRUST_AI_WORKFLOW_DISABLED');
  }
  if (rawSelection === null || typeof rawSelection !== 'object' ||
    Array.isArray(rawSelection) ||
    Object.getPrototypeOf(rawSelection) !== Object.prototype ||
    Object.keys(rawSelection).sort().join('|') !== SELECTOR_KEYS) {
    denied('TRADETRUST_AI_WORKFLOW_SELECTION_INVALID');
  }
  const selection = rawSelection as InternalQuoteSelection;
  const trusted = await resolveTrustedNegotiationContext(
    env, selection.merchantId, selection.quoteId, selection.revisionNo,
  );
  if (trusted.executableOfferAllowed !== false ||
    trusted.policyOrigin !== 'SERVER_DEMO_CONFIG' ||
    trusted.revisionNo !== selection.revisionNo) {
    denied('TRADETRUST_AI_WORKFLOW_CONTEXT_INVALID');
  }
  const suggestion = await requestNegotiationProvider(
    env, trusted.context, buyerMessage, mockTransport,
  );
  if (suggestion.source !== 'MOCK_TRANSPORT' || suggestion.nonBinding !== true) {
    denied('TRADETRUST_AI_WORKFLOW_PROVIDER_INVALID');
  }
  return Object.freeze({
    mode: 'LOCAL_SIMULATION' as const,
    merchantId: trusted.context.merchantId,
    quoteId: trusted.context.quoteId,
    revisionNo: trusted.revisionNo,
    quoteSha256: trusted.context.quoteSha256,
    policyOrigin: trusted.policyOrigin,
    suggestion,
    executableOfferAllowed: false as const,
    merchantApprovalRecorded: false as const,
    paymentInitiated: false as const,
  });
}
