import { authorizeMerchantApproval } from '../auth/merchant-authorization.ts';
import {
  executeOneRealSandboxDraftLocal,
  type RealSandboxLocalEnv,
} from './real-sandbox-draft-local.ts';

export type OneShotEnv = RealSandboxLocalEnv & Readonly<{
  TRADETRUST_PAYPAL_HTTP_MODE?: string;
}>;

const BASE = 'http://127.0.0.1:8787';
const PATH = '/api/local/paypal/sandbox-draft-oneshot';

const BINDING = Object.freeze({
  merchantId: 'merchant-local-demo',
  approvalId: 'aeb058c2-f04d-4515-bf2b-4e0c8c581c37',
});

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

/**
 * LOCAL SANDBOX ONLY.
 *
 * A separately gated wrapper, disabled unless explicitly enabled.
 * The client cannot choose merchant, approval, amount, or buyer.
 * The underlying workflow re-verifies authorization and atomically
 * claims the immutable operation before any external create POST.
 */
export async function localSandboxOneShotHttp(
  request: Request,
  env: OneShotEnv | undefined,
  readBody: (request: Request) => Promise<string>,
): Promise<Response> {
  let url: URL;

  try {
    url = new URL(request.url);
  } catch {
    return reply(404, { error: 'not_found' });
  }

  if (
    url.origin !== BASE ||
    url.pathname !== PATH ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return reply(404, { error: 'not_found' });
  }

  // Three separate execution gates, plus Sandbox and local auth.
  if (
    !env ||
    env.TRADETRUST_PAYPAL_HTTP_MODE !== 'LOCAL_ONESHOT_APPROVED' ||
    env.TRADETRUST_AUTH_MODE !== 'LOCAL_SESSION' ||
    env.PAYPAL_ENVIRONMENT !== 'SANDBOX' ||
    env.PAYPAL_DRAFT_CREATE_MODE !== 'SANDBOX_REAL_ONE_DRAFT' ||
    env.TRADETRUST_SANDBOX_EXECUTION_MODE !== 'LOCAL_SANDBOX_DRAFT_ONESHOT'
  ) {
    return reply(404, { error: 'not_found' });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Allow: 'POST',
      },
    });
  }

  if (request.headers.get('Origin') !== BASE) {
    return reply(403, { error: 'forbidden' });
  }

  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return reply(403, { error: 'forbidden' });
  }

  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
    request.headers.get('Content-Type') || ''
  )) {
    return reply(415, { error: 'unsupported_media_type' });
  }

  const size = request.headers.get('Content-Length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > 32)) {
    return reply(413, { error: 'body_too_large' });
  }

  let body: string;

  try {
    body = await readBody(request);
  } catch {
    return reply(400, { error: 'invalid_request' });
  }

  if (body.length > 32 || body.trim() !== '{}') {
    return reply(400, { error: 'invalid_request' });
  }

  if (!env.DB) {
    return reply(503, { error: 'database_unavailable' });
  }

  // Restrict this one-shot demonstration to an authenticated OWNER.
  try {
    const actor = await authorizeMerchantApproval(
      request, env, BINDING.merchantId
    );
    if (actor.role !== 'OWNER') {
      return reply(403, { error: 'forbidden' });
    }
  } catch {
    return reply(403, { error: 'forbidden' });
  }

  try {
    const outcome = await executeOneRealSandboxDraftLocal(
      request, env, BINDING, fetch
    );

    return reply(201, {
      status: outcome.status,
      invoiceId: outcome.invoiceId,
      operationId: outcome.operationId,
      paymentInitiated: false,
    });
  } catch {
    // Do not retry after an ambiguous external operation.
    return reply(503, {
      error: 'reconciliation_required_do_not_retry',
    });
  }
}
