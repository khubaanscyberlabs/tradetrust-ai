/**
 * 09P-09D-05: DISABLED-by-default, local authenticated advisory execution boundary.
 * Explicit private gates and remote AI configuration are intentionally NOT enabled.
 * The caller is an authenticated local merchant; the AI is not financial authority.
 * No PayPal, payment, approval, quote, or D1 writes in this module.
 *
 * One model attempt per live Worker isolate (not a durable global quota).
 * Never retry even when the result is uncertain. Restarting workerd resets this
 * in-memory lock; separate operator authorization is required for every session.
 */
import { authorizedAiContextPreviewHttp } from './authorized-ai-context-preview-http.ts';
import { previewTrustedCloudflareViaBinding, type ControlledCloudflareEnv } from './trusted-cloudflare-binding.ts';
import { localConfigured, localRequest, LOCAL_ORIGIN, type LocalSessionConfig } from '../auth/local-session.ts';
import type { MerchantAuthEnvironment } from '../auth/merchant-authorization.ts';

type Env = ControlledCloudflareEnv & MerchantAuthEnvironment & LocalSessionConfig & Readonly<{
  TRADETRUST_CF_AI_HTTP_MODE?: string;
}>;
const MERCHANT = 'merchant-local-demo';
const QUOTE = '21c50c14-fe6b-4c5f-9811-aee5306aa38c';
const HASH = '225b8ff7fb7f90ca06c80ce809409ee5d524590ce506b189c566c24bddbd5235';
const REVISION = 1;
let oneAttemptConsumed = false;

function respond(status: number, body: unknown, extra: Record<string,string> = {}): Response {
  return new Response(JSON.stringify(body), {status, headers:{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Cross-Origin-Resource-Policy':'same-origin',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",
    ...extra,
  }});
}

export async function authorizedAiAdvisoryHttp(
  request: Request,
  env: Env | undefined,
  readBody: (r:Request)=>Promise<string>,
): Promise<Response> {
  // Absent gates mean no operational endpoint, no D1 access and no model call.
  if (!env || !localConfigured(env) || !env.DB ||
      env.TRADETRUST_AUTH_MODE !== 'LOCAL_SESSION' ||
      env.TRADETRUST_AI_CONTEXT_MODE !== 'LOCAL_SIMULATION' ||
      env.TRADETRUST_CF_AI_WORKFLOW_MODE !== 'LOCAL_EXPLICIT_TEST_ONLY' ||
      env.TRADETRUST_CF_AI_EXECUTION_MODE !== 'LOCAL_EXPLICIT_TEST_ONLY' ||
      env.TRADETRUST_CF_AI_HTTP_MODE !== 'LOCAL_AUTHENTICATED_ONESHOT' ||
      !env.AI || typeof env.AI.run !== 'function' ||
      new URL(request.url).origin !== LOCAL_ORIGIN) {
    return respond(404,{error:'not_found'});
  }
  if (request.method !== 'POST') {
    return respond(405,{error:'method_not_allowed'},{Allow:'POST'});
  }
  if (!localRequest(request,env)) {
    return respond(403,{error:'forbidden'});
  }
  // The already tested read-only preview enforces authenticated D1 membership,
  // approval presence, exact approved revision/hash/total, server policy,
  // Content-Type and buyer-message strict schema. Do not bypass it.
  let previewRequest: Request;
  try { previewRequest = request.clone(); }
  catch { return respond(400,{error:'invalid_request'}); }
  const preview = await authorizedAiContextPreviewHttp(previewRequest,env,readBody);
  if (preview.status !== 200) return preview;
  let body: unknown;
  let inspected: unknown;
  try {
    body = JSON.parse(await readBody(request));
    inspected = await preview.json();
  } catch {return respond(400,{error:'invalid_request'});}
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).join('|') !== 'buyerMessage' ||
      typeof (body as {buyerMessage:unknown}).buyerMessage !== 'string' ||
      !inspected || typeof inspected !== 'object' || Array.isArray(inspected)) {
    return respond(400,{error:'invalid_request'});
  }
  const context = inspected as Record<string,unknown>;
  if (context.mode !== 'LOCAL_APPROVED_AI_CONTEXT_PREVIEW' ||
      context.merchantId !== MERCHANT || context.quoteId !== QUOTE ||
      context.revisionNo !== REVISION || context.quoteSha256 !== HASH ||
      context.currency !== 'USD' || context.totalCents !== 10900 ||
      context.approvedQuoteVerified !== true || context.contextPrepared !== true ||
      context.actualModelInference !== false || context.providerCallAttempted !== false ||
      context.executableOfferAllowed !== false || context.merchantApprovalRecorded !== false ||
      context.paymentInitiated !== false || context.policyOrigin !== 'SERVER_DEMO_CONFIG' ||
      !Number.isSafeInteger(context.maxDemoDiscountBps) ||
      (context.maxDemoDiscountBps as number) < 0 || (context.maxDemoDiscountBps as number) > 500) {
    return respond(503,{error:'approved_context_unavailable'});
  }

  // Per-live-isolate lock. Acquire synchronously before first await/provider call.
  // Inference uncertainty consumes the attempt; no retries in this handler.
  if (oneAttemptConsumed) return respond(409,{error:'one_attempt_already_consumed'});
  oneAttemptConsumed = true;
  try {
    const execution = await previewTrustedCloudflareViaBinding(
      env,
      {merchantId:MERCHANT,quoteId:QUOTE,revisionNo:REVISION},
      (body as {buyerMessage:string}).buyerMessage,
    );
    if (execution.mode !== 'INTERNAL_LOCAL_BINDING' ||
        execution.merchantId !== MERCHANT || execution.quoteId !== QUOTE ||
        execution.quoteSha256 !== HASH || execution.revisionNo !== REVISION ||
        execution.policyOrigin !== 'SERVER_DEMO_CONFIG' ||
        execution.providerCallAttempted !== true ||
        execution.executableOfferAllowed !== false ||
        execution.merchantApprovalRecorded !== false || execution.paymentInitiated !== false ||
        execution.advisory.nonBinding !== true ||
        execution.advisory.executableOfferAllowed !== false ||
        execution.advisory.merchantApprovalRecorded !== false ||
        execution.advisory.paymentInitiated !== false) {
      return respond(503,{error:'ai_advisory_unavailable'});
    }
    return respond(200,{
      mode:'LOCAL_AUTHENTICATED_NONBINDING_AI_ADVISORY',
      merchantId:MERCHANT, quoteId:QUOTE, revisionNo:REVISION,
      quoteSha256:HASH, currency:'USD', totalCents:10900,
      model:execution.model, policyOrigin:execution.policyOrigin,
      advisory:execution.advisory,
      providerCallAttempted:true, oneAttemptConsumed:true,
      executableOfferAllowed:false, merchantApprovalRecorded:false, paymentInitiated:false,
    });
  } catch {
    return respond(503,{
      error:'ai_advisory_unavailable', oneAttemptConsumed:true,
      automaticRetry:false, paymentInitiated:false,
    });
  }
}
