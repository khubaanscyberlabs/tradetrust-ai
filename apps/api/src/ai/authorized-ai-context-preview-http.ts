/** 09P-09B: Authenticated LOCAL-only, D1-approved AI context preview.
 * Does not invoke Workers AI, a payment provider, or perform database writes.
 * Not a real AI response. The executable AI route is NOT created here.
 */
import { authorizeMerchantApproval, type MerchantAuthEnvironment } from '../auth/merchant-authorization.ts';
import { localConfigured, LOCAL_ORIGIN } from '../auth/local-session.ts';
import { resolveTrustedNegotiationContext, type TrustedContextEnv } from './trusted-context.ts';
import { buildCloudflareNegotiationRequest } from './cloudflare-provider.ts';

type Env = MerchantAuthEnvironment & TrustedContextEnv;
type ApprovedRow = { approval_id: string };
const MERCHANT = 'merchant-local-demo';
const QUOTE = '21c50c14-fe6b-4c5f-9811-aee5306aa38c';
const HASH = '225b8ff7fb7f90ca06c80ce809409ee5d524590ce506b189c566c24bddbd5235';
const REVISION = 1;
const APPROVED_SQL = `SELECT a.id AS approval_id FROM approvals a
 INNER JOIN quote_revisions r ON r.merchant_id=a.merchant_id
 AND r.quote_id=a.quote_id AND r.revision_no=a.revision_no
 AND r.snapshot_sha256=a.snapshot_sha256
 WHERE a.merchant_id=? AND a.quote_id=? AND a.revision_no=?
 AND a.snapshot_sha256=? AND r.currency='USD' AND r.total_cents=10900
 AND r.revision_no=(SELECT MAX(v.revision_no) FROM quote_revisions v
 WHERE v.merchant_id=a.merchant_id AND v.quote_id=a.quote_id)
 LIMIT 1`;

function json(status:number, value:unknown, extras:Record<string,string> = {}): Response {
  return new Response(JSON.stringify(value), {status, headers:{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Cross-Origin-Resource-Policy':'same-origin',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",
    ...extras,
  }});
}

export async function authorizedAiContextPreviewHttp(
  request:Request, env:Env|undefined,
  readBody:(r:Request)=>Promise<string>,
):Promise<Response> {
  if (!env || !localConfigured(env) || env.TRADETRUST_AUTH_MODE !== 'LOCAL_SESSION' ||
      env.TRADETRUST_AI_CONTEXT_MODE !== 'LOCAL_SIMULATION' ||
      !env.DB || new URL(request.url).origin !== LOCAL_ORIGIN) {
    return json(404,{error:'not_found'});
  }
  if (request.method !== 'POST') return json(405,{error:'method_not_allowed'},{Allow:'POST'});
  if (request.headers.get('Origin') !== LOCAL_ORIGIN) return json(403,{error:'forbidden'});
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type')||'')) {
    return json(415,{error:'unsupported_media_type'});
  }
  const claimed = request.headers.get('Content-Length');
  if (claimed !== null && (!/^\d+$/.test(claimed) || Number(claimed)>1400)) {
    return json(413,{error:'body_too_large'});
  }
  try { await authorizeMerchantApproval(request,env,MERCHANT); }
  catch { return json(403,{error:'forbidden'}); }

  let buyerMessage:string;
  try {
    const raw = await readBody(request);
    if (new TextEncoder().encode(raw).length > 1400) return json(413,{error:'body_too_large'});
    const parsed:unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join('|') !== 'buyerMessage' ||
        typeof (parsed as {buyerMessage:unknown}).buyerMessage !== 'string') {
      return json(400,{error:'invalid_request'});
    }
    buyerMessage = (parsed as {buyerMessage:string}).buyerMessage;
    if (buyerMessage.length < 3 || buyerMessage.length > 500 || !buyerMessage.trim() ||
        /[\u0000-\u001f\u007f]/.test(buyerMessage)) {
      return json(422,{error:'invalid_buyer_message'});
    }
  } catch { return json(400,{error:'invalid_request'}); }

  try {
    const approval = await env.DB.prepare(APPROVED_SQL)
      .bind(MERCHANT,QUOTE,String(REVISION),HASH).first<ApprovedRow>();
    if (!approval || typeof approval.approval_id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(approval.approval_id)) {
      return json(503,{error:'approved_context_unavailable'});
    }
    const trusted = await resolveTrustedNegotiationContext(env,MERCHANT,QUOTE,REVISION);
    if (trusted.context.merchantId !== MERCHANT || trusted.context.quoteId !== QUOTE ||
        trusted.context.quoteSha256 !== HASH || trusted.revisionNo !== REVISION ||
        trusted.policyOrigin !== 'SERVER_DEMO_CONFIG' ||
        trusted.executableOfferAllowed !== false) {
      return json(503,{error:'approved_context_unavailable'});
    }
    const built = buildCloudflareNegotiationRequest(trusted.context,buyerMessage);
    if (built.quoteIdentity.quoteSha256 !== HASH ||
        built.quoteIdentity.merchantId !== MERCHANT ||
        built.quoteIdentity.quoteId !== QUOTE) {
      return json(503,{error:'approved_context_unavailable'});
    }
    // Only metadata is returned. Neither the model prompt nor an invented AI answer is exposed.
    return json(200,{
      mode:'LOCAL_APPROVED_AI_CONTEXT_PREVIEW',
      merchantId:MERCHANT, quoteId:QUOTE, revisionNo:REVISION,
      quoteSha256:HASH, currency:'USD', totalCents:10900,
      model:built.model, policyOrigin:'SERVER_DEMO_CONFIG',
      maxDemoDiscountBps:trusted.context.maxDiscountBps,
      approvedQuoteVerified:true, contextPrepared:true,
      actualModelInference:false, providerCallAttempted:false,
      executableOfferAllowed:false, merchantApprovalRecorded:false,
      paymentInitiated:false,
    });
  } catch { return json(503,{error:'approved_context_unavailable'}); }
}
