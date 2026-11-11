import { proposeQuote } from './domain/quote.ts';

type Statement = {
  bind(...values: (string | number)[]): Statement;
};

type LocalDb = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown>;
};

export type LocalEnv = {
  DB?: LocalDb;
  LOCAL_DEALROOM_MODE?: string;
  LOCAL_DEALROOM_TOKEN?: string;
};

function respond(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
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

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}

export async function localQuoteEndpoint(
  request: Request,
  env: LocalEnv | undefined,
  readBody: (request: Request) => Promise<string>,
): Promise<Response> {
  const hostname = new URL(request.url).hostname;

  // This endpoint must never work without explicit local setup.
  if (
    !['localhost', '127.0.0.1'].includes(hostname) ||
    env?.LOCAL_DEALROOM_MODE !== 'enabled' ||
    typeof env.LOCAL_DEALROOM_TOKEN !== 'string' ||
    env.LOCAL_DEALROOM_TOKEN.length < 40
  ) {
    return respond({ error: 'not_found' }, 404);
  }

  if (request.method !== 'POST') {
    return respond({ error: 'method_not_allowed' }, 405);
  }

  const token = request.headers.get('X-Local-Token');

  if (!token || token !== env.LOCAL_DEALROOM_TOKEN) {
    return respond({ error: 'unauthorized' }, 401);
  }

  if (!env.DB) {
    return respond({ error: 'database_unavailable' }, 503);
  }

  if (
    request.headers.get('Origin') &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
      request.headers.get('Origin')!
    )
  ) {
    return respond({ error: 'forbidden_origin' }, 403);
  }

  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers.get('Content-Type') || ''
    )
  ) {
    return respond({ error: 'unsupported_media_type' }, 415);
  }

  const length = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > 8192) {
    return respond({ error: 'body_too_large' }, 413);
  }

  let payload: unknown;

  try {
    payload = JSON.parse(await readBody(request));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'BODY_TOO_LARGE'
    ) {
      return respond({ error: 'body_too_large' }, 413);
    }

    return respond({ error: 'invalid_json' }, 400);
  }

  let quote: ReturnType<typeof proposeQuote>;

  try {
    quote = proposeQuote(payload);
  } catch {
    return respond({ error: 'invalid_quote' }, 422);
  }

  const merchantId = 'merchant-local-demo';
  const dealroomId = 'dealroom-local-demo';
  const quoteId = crypto.randomUUID();
  const auditId = crypto.randomUUID();

  const snapshot = JSON.stringify(quote);
  const hash = await sha256(snapshot);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO quotes
         (id, merchant_id, dealroom_id)
         VALUES (?, ?, ?)`
      ).bind(quoteId, merchantId, dealroomId),

      env.DB.prepare(
        `INSERT INTO quote_revisions (
          quote_id, merchant_id, revision_no,
          currency, subtotal_cents, discount_cents,
          shipping_cents, total_cents,
          snapshot_json, snapshot_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        quoteId, merchantId, 1, 'USD',
        quote.subtotalCents,
        quote.discountCents,
        quote.shippingCents,
        quote.totalCents,
        snapshot, hash
      ),

      env.DB.prepare(
        `INSERT INTO audit_events (
          id, merchant_id, action,
          actor_id, entity_id, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        auditId, merchantId, 'QUOTE_PROPOSED',
        'local-test-actor', quoteId,
        JSON.stringify({
          revision: 1,
          snapshot_sha256: hash
        })
      ),
    ]);
  } catch {
    // Do not expose database error details or SQL to callers.
    return respond({ error: 'persistence_failed' }, 503);
  }

  return respond({
    quoteId,
    revision: 1,
    snapshotSha256: hash,
    status: 'PROPOSAL_REQUIRES_MERCHANT_APPROVAL',
    totalCents: quote.totalCents,
    currency: quote.currency,
    paymentInitiated: false,
  }, 201);
}
