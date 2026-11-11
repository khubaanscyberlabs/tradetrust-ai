import { proposeQuote } from './domain/quote.ts';
import { localQuoteEndpoint, type LocalEnv } from './local-quote.ts';
import { approvalHttpEndpoint, type ApprovalHttpEnv } from './approval-http.ts';
import { commercialReviewHttpEndpoint, type CommercialReviewHttpEnv } from './commercial-review-http.ts';
import { authorizedAiContextPreviewHttp } from './ai/authorized-ai-context-preview-http.ts';
import { authorizedAiAdvisoryHttp } from './ai/authorized-ai-advisory-http.ts';

import {localSessionEndpoint} from './auth/local-session.ts';
import { localDemoEvidenceEndpoint } from './local-demo-evidence.ts';
import { localSandboxOneShotHttp } from './paypal/local-sandbox-oneshot-http.ts';

const MAX_BODY_BYTES = 8192;

const SAFE_ERRORS = new Set([
  'Quote must be a JSON object',
  'Unexpected field in quote request',
  'Items must contain 1–10 lines',
  'Invalid shipping method',
  'Discount exceeds merchant policy',
  'Invalid item',
  'Unknown SKU',
  'Duplicate SKU',
  'Invalid quantity or insufficient stock',
  'Unsafe amount',
]);

function json(
  value: unknown,
  status = 200,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extra,
    },
  });
}

async function readLimitedBody(
  request: Request,
): Promise<string> {
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > MAX_BODY_BYTES) {
        throw Error('BODY_TOO_LARGE');
      }

      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder('utf-8', {
    fatal: true,
  }).decode(bytes);
}

export async function handleRequest(
  request: Request,
  env?: LocalEnv & ApprovalHttpEnv & CommercialReviewHttpEnv & NonNullable<Parameters<typeof localSessionEndpoint>[1]>,
): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === '/api/local-auth/login' || path === '/api/local-auth/logout') {
    return localSessionEndpoint(request, env, readLimitedBody);
  }

  if (path === '/api/dev/quotes') {
    return localQuoteEndpoint(request, env, readLimitedBody);
  }

  if (path === '/api/merchant/terms-review') {
    return commercialReviewHttpEndpoint(request, env, readLimitedBody);
  }

  if (path === '/api/merchant/ai-advisory') {
    return authorizedAiAdvisoryHttp(request, env, readLimitedBody);
  }

  if (path === '/api/merchant/ai-context-preview') {
    return authorizedAiContextPreviewHttp(request, env, readLimitedBody);
  }

  if (path === '/api/merchant/approve') {
    return approvalHttpEndpoint(request, env, readLimitedBody);
  }

  if (path === '/api/merchant/demo-evidence') {
    return localDemoEvidenceEndpoint(request, env, readLimitedBody);
  }

  if (path === '/api/local/paypal/sandbox-draft-oneshot') {
    return localSandboxOneShotHttp(
      request,
      env as Parameters<typeof localSandboxOneShotHttp>[1],
      readLimitedBody,
    );
  }

  if (path === '/health') {
    return request.method === 'GET'
      ? json({ status: 'ok' })
      : json(
          { error: 'method_not_allowed' },
          405,
          { Allow: 'GET' },
        );
  }

  if (path !== '/api/quotes/preview') {
    return json({ error: 'not_found' }, 404);
  }

  if (request.method !== 'POST') {
    return json(
      { error: 'method_not_allowed' },
      405,
      { Allow: 'POST' },
    );
  }

  const contentType =
    request.headers.get('Content-Type') || '';

  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i
      .test(contentType)
  ) {
    return json(
      { error: 'unsupported_media_type' },
      415,
    );
  }

  const length = Number(
    request.headers.get('Content-Length'),
  );

  if (
    Number.isFinite(length) &&
    length > MAX_BODY_BYTES
  ) {
    return json({ error: 'body_too_large' }, 413);
  }

  let payload: unknown;

  try {
    const body = await readLimitedBody(request);
    payload = JSON.parse(body);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'BODY_TOO_LARGE'
    ) {
      return json({ error: 'body_too_large' }, 413);
    }

    return json({ error: 'invalid_json' }, 400);
  }

  try {
    const quote = proposeQuote(payload);

    return json({
      quote,
      note:
        'Preview only. Merchant approval required. ' +
        'No payment initiated.',
    });
  } catch (error) {
    if (
      error instanceof Error &&
      SAFE_ERRORS.has(error.message)
    ) {
      return json({
        error: 'invalid_quote',
        detail: error.message,
      }, 422);
    }

    return json({ error: 'internal_error' }, 500);
  }
}

export default {
  fetch: handleRequest,
};
