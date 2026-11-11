import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * Server-side Cloudflare Access authentication.
 *
 * This module verifies human identity only.
 * It does not grant merchant roles or approval rights.
 */

export type AccessConfig = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};

export type VerifiedAccessHuman = Readonly<{
  provider: 'CLOUDFLARE_ACCESS';
  issuer: string;
  subject: string;
}>;

const TEAM_PATTERN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

const keysets = new Map<string, JWTVerifyGetKey>();

function reject(): never {
  throw new Error('ACCESS_IDENTITY_REJECTED');
}

function getKeyset(team: string): JWTVerifyGetKey {
  let keyset = keysets.get(team);

  if (!keyset) {
    keyset = createRemoteJWKSet(
      new URL(`${team}/cdn-cgi/access/certs`),
      {
        timeoutDuration: 5000,
        cooldownDuration: 30000,
      },
    );

    keysets.set(team, keyset);
  }

  return keyset;
}

export async function verifyAccessHuman(
  request: Request,
  config: AccessConfig,
  // Test-only injection: production callers must omit it.
  testKeyset?: JWTVerifyGetKey,
): Promise<VerifiedAccessHuman> {
  const team = config.ACCESS_TEAM_DOMAIN;
  const audience = config.ACCESS_AUD;

  if (
    typeof team !== 'string' ||
    !TEAM_PATTERN.test(team) ||
    typeof audience !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(audience)
  ) {
    throw new Error('ACCESS_CONFIGURATION_INVALID');
  }

  const token = request.headers.get(
    'Cf-Access-Jwt-Assertion',
  );

  if (
    !token ||
    token.length > 12000 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
      .test(token)
  ) {
    reject();
  }

  try {
    const keyset = testKeyset ?? getKeyset(team);

    const { payload } = await jwtVerify(token, keyset, {
      issuer: team,
      audience,
      algorithms: ['RS256'],
      requiredClaims: [
        'iss', 'aud', 'sub', 'iat', 'exp', 'type',
      ],
      clockTolerance: 5,
    });

    const now = Math.floor(Date.now() / 1000);

    // Only application tokens representing a human IdP
    // identity are acceptable. Service tokens are excluded.
    if (
      payload.type !== 'app' ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      payload.sub.length > 250 ||
      payload.sub.trim() !== payload.sub ||
      typeof payload.email !== 'string' ||
      !payload.email.includes('@') ||
      'common_name' in payload ||
      !Number.isInteger(payload.iat) ||
      (payload.iat as number) > now + 5 ||
      !Number.isInteger(payload.exp) ||
      (payload.exp as number) <=
        (payload.iat as number)
    ) {
      reject();
    }

    return Object.freeze({
      provider: 'CLOUDFLARE_ACCESS',
      issuer: team,
      subject: payload.sub,
    });
  } catch {
    // Do not leak JWTs, upstream errors, or internal claims.
    reject();
  }
}
