/**
 * TradeTrust AI — PayPal Sandbox capability adapter.
 *
 * Server-side only.
 * No invoice creation or financial mutations.
 */

export type SandboxCredentials = {
  PAYPAL_ENVIRONMENT?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
};

const BASE = 'https://api-m.sandbox.paypal.com';

const INVOICING_SCOPE =
  'https://uri.paypal.com/services/invoicing';

function credentials(
  env: SandboxCredentials,
): { id: string; secret: string } {
  if (env.PAYPAL_ENVIRONMENT !== 'SANDBOX') {
    throw new Error('PAYPAL_SANDBOX_ONLY');
  }

  const id = env.PAYPAL_CLIENT_ID;
  const secret = env.PAYPAL_CLIENT_SECRET;

  if (
    typeof id !== 'string' ||
    !id ||
    id.includes(':') ||
    /[\r\n]/.test(id) ||
    typeof secret !== 'string' ||
    !secret ||
    /[\r\n]/.test(secret)
  ) {
    throw new Error(
      'PAYPAL_CREDENTIALS_MISSING_OR_INVALID',
    );
  }

  return { id, secret };
}

async function safeFetch(
  transport: typeof fetch,
  path: string,
  options: RequestInit,
): Promise<Response> {
  try {
    return await transport(BASE + path, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Never expose request credentials or upstream errors.
    throw new Error('PAYPAL_SANDBOX_NETWORK_ERROR');
  }
}

export async function verifySandboxInvoicing(
  env: SandboxCredentials,
  transport: typeof fetch = fetch,
): Promise<Readonly<{
  oauthAuthenticated: true;
  invoicingScope: true;
  invoiceReadAccess: true;
}>> {
  const { id, secret } = credentials(env);

  const auth = btoa(`${id}:${secret}`);

  const tokenResponse = await safeFetch(
    transport,
    '/v1/oauth2/token',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type':
          'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    },
  );

  if (!tokenResponse.ok) {
    throw new Error('PAYPAL_SANDBOX_OAUTH_REJECTED');
  }

  let tokenResult: unknown;

  try {
    tokenResult = await tokenResponse.json();
  } catch {
    throw new Error(
      'PAYPAL_SANDBOX_OAUTH_BAD_RESPONSE',
    );
  }

  if (
    !tokenResult ||
    typeof tokenResult !== 'object' ||
    !('access_token' in tokenResult) ||
    typeof tokenResult.access_token !== 'string' ||
    !tokenResult.access_token ||
    !('token_type' in tokenResult) ||
    typeof tokenResult.token_type !== 'string' ||
    tokenResult.token_type.toLowerCase() !== 'bearer'
  ) {
    throw new Error(
      'PAYPAL_SANDBOX_OAUTH_BAD_RESPONSE',
    );
  }

  const scope =
    'scope' in tokenResult &&
    typeof tokenResult.scope === 'string'
      ? tokenResult.scope.split(/\s+/)
      : [];

  if (!scope.includes(INVOICING_SCOPE)) {
    throw new Error(
      'PAYPAL_SANDBOX_INVOICING_SCOPE_MISSING',
    );
  }

  const invoiceResponse = await safeFetch(
    transport,
    '/v2/invoicing/invoices?page=1&page_size=1',
    {
      method: 'GET',
      headers: {
        Authorization:
          `Bearer ${tokenResult.access_token}`,
        Accept: 'application/json',
      },
    },
  );

  if (!invoiceResponse.ok) {
    throw new Error(
      'PAYPAL_SANDBOX_INVOICING_READ_REJECTED',
    );
  }

  return Object.freeze({
    oauthAuthenticated: true,
    invoicingScope: true,
    invoiceReadAccess: true,
  });
}
