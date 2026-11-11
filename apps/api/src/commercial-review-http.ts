/**
 * 09F-02: deliberately dormant, protected, read-only merchant review endpoint.
 * OWNER/MANAGER access only; no browser-supplied identity, pricing, or approval.
 * Only a verified latest D1 quote revision may be assessed.
 */
import type { JWTVerifyGetKey } from 'jose';
import {localConfigured, LOCAL_ORIGIN} from './auth/local-session.ts';
import { authorizeMerchantApproval, type MerchantAuthEnvironment } from './auth/merchant-authorization.ts';
import { assessTrustedCommercialTermsLocal, type TrustedTermsEnv } from './ai/trusted-commercial-terms-local.ts';

export type CommercialReviewHttpEnv = MerchantAuthEnvironment & TrustedTermsEnv & Readonly<{
  TRADETRUST_TERMS_HTTP_MODE?: string;
  TRADETRUST_TERMS_ALLOWED_ORIGIN?: string;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_BODY_BYTES = 8192;

function reply(value: unknown, status: number, extra: Record<string,string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Cross-Origin-Resource-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",
    ...extra,
  }});
}
function configuredOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256 || !value.startsWith('https://')) return null;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.search || url.hash || url.port || url.pathname !== '/') return null;
    return value;
  } catch { return null; }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(d => 'value' in d && d.enumerable);
}
function exact(value: unknown, fields: string): value is Record<string,unknown> {
  return object(value) && Object.keys(value).sort().join('|') === fields;
}

/** The optional keyset exists solely for direct offline tests; index.ts never supplies it. */
export async function commercialReviewHttpEndpoint(
  request: Request,
  env: CommercialReviewHttpEnv | undefined,
  readBody: (request: Request) => Promise<string>,
  testKeyset?: JWTVerifyGetKey,
): Promise<Response> {
  const origin = env?.TRADETRUST_AUTH_MODE === 'LOCAL_SESSION'
    ? (localConfigured(env) && env.TRADETRUST_TERMS_ALLOWED_ORIGIN === LOCAL_ORIGIN ? LOCAL_ORIGIN : null)
    : configuredOrigin(env?.TRADETRUST_TERMS_ALLOWED_ORIGIN);
  if (env?.TRADETRUST_TERMS_HTTP_MODE !== 'enabled' ||
      env.TRADETRUST_TERMS_REVIEW_MODE !== 'LOCAL_SIMULATION' ||
      env.TRADETRUST_AI_CONTEXT_MODE !== 'LOCAL_SIMULATION' ||
      !origin || !env.DB || (!localConfigured(env) && (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD))) {
    return reply({error:'not_found'},404);
  }
  if (new URL(request.url).origin !== origin) return reply({error:'not_found'},404);
  if (request.method !== 'POST') return reply({error:'method_not_allowed'},405,{Allow:'POST'});
  if (request.headers.get('Origin') !== origin) return reply({error:'forbidden_origin'},403);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) {
    return reply({error:'unsupported_media_type'},415);
  }
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length)>MAX_BODY_BYTES)) {
    return reply({error:'body_too_large'},413);
  }
  let input: unknown;
  try { input = JSON.parse(await readBody(request)); }
  catch (error) {
    if (error instanceof Error && error.message === 'BODY_TOO_LARGE') return reply({error:'body_too_large'},413);
    return reply({error:'invalid_json'},400);
  }
  if (!exact(input,'buyer|merchantId|quoteId|revisionNo') ||
      typeof input.merchantId !== 'string' || !ID.test(input.merchantId) ||
      typeof input.quoteId !== 'string' || !ID.test(input.quoteId) ||
      typeof input.revisionNo !== 'number' || !Number.isSafeInteger(input.revisionNo) ||
      input.revisionNo < 1 || input.revisionNo > 2147483647 || !object(input.buyer)) {
    return reply({error:'invalid_request'},400);
  }
  // Exactly one configured identity source, never request body identity data.
  // Until a dedicated review policy is designed, only OWNER/MANAGER is permitted.
  try { await authorizeMerchantApproval(request,env,input.merchantId,testKeyset); }
  catch { return reply({error:'forbidden'},403); }
  try {
    const result = await assessTrustedCommercialTermsLocal(
      env,
      {merchantId:input.merchantId,quoteId:input.quoteId,revisionNo:input.revisionNo},
      input.buyer,
    );
    // The result is nonbinding; it grants no authorization to approve or invoice.
    return reply({review:result},200);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'TRADETRUST_TERMS_BUYER_REJECTED') return reply({error:'invalid_buyer_terms'},422);
    // All other trusted-context, stale-revision and D1 errors are non-disclosing.
    return reply({error:'review_unavailable'},503);
  }
}
