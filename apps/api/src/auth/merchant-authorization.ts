import type { JWTVerifyGetKey } from 'jose';
import {verifyLocalHuman, type LocalSessionConfig} from './local-session.ts';

import {
  verifyAccessHuman,
  type AccessConfig,
} from './access-identity.ts';

/**
 * TradeTrust AI — merchant approval authorization.
 *
 * Authentication: signed Cloudflare Access human JWT.
 * Authorization: active merchant membership in D1.
 *
 * No database writes.
 * No approval or payment operations.
 */

type MembershipRow = {
  actor_id: string;
  role: string;
};

type ReadStatement = {
  bind(...values: string[]): {
    first<T>(): Promise<T | null>;
  };
};

type ReadDatabase = {
  prepare(sql: string): ReadStatement;
};

export type MerchantAuthEnvironment =
  AccessConfig & LocalSessionConfig & {
    DB?: ReadDatabase;
  };

export type AuthorizedMerchant = Readonly<{
  actorId: string;
  merchantId: string;
  role: 'OWNER' | 'MANAGER';
}>;

const MERCHANT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const MEMBERSHIP_SQL = `
  SELECT
    a.id AS actor_id,
    m.role AS role
  FROM merchant_actors a
  INNER JOIN merchant_memberships m
    ON m.actor_id = a.id
  WHERE a.provider = ?
    AND a.issuer = ?
    AND a.subject = ?
    AND a.status = 'ACTIVE'
    AND m.status = 'ACTIVE'
    AND m.merchant_id = ?
    AND m.role IN ('OWNER', 'MANAGER')
  LIMIT 1
`;

function deny(): never {
  throw new Error('MERCHANT_AUTHORIZATION_DENIED');
}

export async function authorizeMerchantApproval(
  request: Request,
  env: MerchantAuthEnvironment | undefined,
  merchantId: string,
  // Test-only key injection. Production must omit it.
  testKeyset?: JWTVerifyGetKey,
): Promise<AuthorizedMerchant> {
  if (
    typeof merchantId !== 'string' ||
    !MERCHANT_ID_PATTERN.test(merchantId) ||
    !env?.DB ||
    typeof env.DB.prepare !== 'function'
  ) {
    deny();
  }

  try {
    // Never trust identity claims supplied by a client body.
    // The explicit mode selects one verified identity source; no fallback.
    if (env.TRADETRUST_AUTH_MODE !== undefined && env.TRADETRUST_AUTH_MODE !== 'LOCAL_SESSION') deny();
    const identity = env.TRADETRUST_AUTH_MODE === 'LOCAL_SESSION'
      ? await verifyLocalHuman(request, env)
      : await verifyAccessHuman(request, env, testKeyset);

    const row = await env.DB
      .prepare(MEMBERSHIP_SQL)
      .bind(
        identity.provider,
        identity.issuer,
        identity.subject,
        merchantId,
      )
      .first<MembershipRow>();

    if (
      !row ||
      typeof row.actor_id !== 'string' ||
      !MERCHANT_ID_PATTERN.test(row.actor_id) ||
      (row.role !== 'OWNER' &&
        row.role !== 'MANAGER')
    ) {
      deny();
    }

    return Object.freeze({
      actorId: row.actor_id,
      merchantId,
      role: row.role,
    });
  } catch {
    // No upstream, SQL, identity or membership details
    // are exposed to an unauthorized caller.
    deny();
  }
}
