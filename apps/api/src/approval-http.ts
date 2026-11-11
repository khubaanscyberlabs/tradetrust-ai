import type { JWTVerifyGetKey } from 'jose';
import {localConfigured, LOCAL_ORIGIN} from './auth/local-session.ts';
import { approveQuote } from './approval-service.ts';

export type ApprovalHttpEnv =
  NonNullable<Parameters<typeof approveQuote>[1]> & {
    APPROVAL_API_MODE?: string;
    APPROVAL_ALLOWED_ORIGIN?: string;
  };

function respond(
  body: unknown,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'none'; frame-ancestors 'none'",
      ...extra,
    },
  });
}

function allowedOrigin(
  env: ApprovalHttpEnv | undefined,
): string | null {
  const origin = env?.APPROVAL_ALLOWED_ORIGIN;
  if (env?.TRADETRUST_AUTH_MODE === 'LOCAL_SESSION') {
    return localConfigured(env) && origin === LOCAL_ORIGIN ? origin : null;
  }

  if (
    typeof origin !== 'string' ||
    origin.length > 256 ||
    !origin.startsWith('https://')
  ) {
    return null;
  }

  try {
    const url = new URL(origin);

    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      url.pathname !== '/'
    ) {
      return null;
    }

    return origin;
  } catch {
    return null;
  }
}

/**
 * Protected approval API.
 *
 * Disabled unless deliberately configured.
 * No PayPal operations.
 *
 * The optional keyset is for isolated unit tests.
 * The Worker router never supplies it.
 */
export async function approvalHttpEndpoint(
  request: Request,
  env: ApprovalHttpEnv | undefined,
  readBody: (r: Request) => Promise<string>,
  testKeyset?: JWTVerifyGetKey,
): Promise<Response> {
  const origin = allowedOrigin(env);

  if (
    env?.APPROVAL_API_MODE !== 'enabled' ||
    !origin ||
    (!localConfigured(env) && (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)) ||
    !env.DB
  ) {
    return respond({ error: 'not_found' }, 404);
  }

  if (new URL(request.url).origin !== origin) {
    return respond({ error: 'not_found' }, 404);
  }

  if (request.method !== 'POST') {
    return respond(
      { error: 'method_not_allowed' },
      405,
      { Allow: 'POST' },
    );
  }

  // Defense against cross-site browser submissions.
  if (request.headers.get('Origin') !== origin) {
    return respond({ error: 'forbidden_origin' }, 403);
  }

  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i
      .test(request.headers.get('Content-Type') || '')
  ) {
    return respond(
      { error: 'unsupported_media_type' },
      415,
    );
  }

  const length = request.headers.get('Content-Length');

  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > 8192)
  ) {
    return respond({ error: 'body_too_large' }, 413);
  }

  let input: unknown;

  try {
    input = JSON.parse(await readBody(request));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'BODY_TOO_LARGE'
    ) {
      return respond({ error: 'body_too_large' }, 413);
    }

    return respond({ error: 'invalid_json' }, 400);
  }

  try {
    const result = await approveQuote(
      request,
      env,
      input,
      testKeyset,
    );

    return respond(
      {
        approval: result,
        status: 'MERCHANT_APPROVED',
      },
      result.replayed ? 200 : 201,
    );
  } catch (error) {
    const code = error instanceof Error
      ? error.message
      : '';

    if (code === 'APPROVAL_REQUEST_INVALID') {
      return respond({ error: 'invalid_request' }, 400);
    }

    if (code === 'MERCHANT_AUTHORIZATION_DENIED') {
      return respond({ error: 'forbidden' }, 403);
    }

    if (
      code === 'APPROVAL_STALE_OR_NOT_FOUND' ||
      code === 'APPROVAL_IDEMPOTENCY_CONFLICT' ||
      code === 'APPROVAL_NOT_COMMITTED'
    ) {
      return respond({ error: 'approval_conflict' }, 409);
    }

    // Do not reveal database or identity-provider errors.
    return respond(
      { error: 'approval_unavailable' },
      503,
    );
  }
}
