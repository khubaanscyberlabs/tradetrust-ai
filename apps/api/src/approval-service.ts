import type { JWTVerifyGetKey } from 'jose';
import type {LocalSessionConfig} from './auth/local-session.ts';
import {
  authorizeMerchantApproval,
} from './auth/merchant-authorization.ts';

type Statement = {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
};

type ApprovalDb = {
  prepare(sql: string): Statement;
  batch(
    statements: Statement[],
  ): Promise<Array<{ success: boolean }>>;
};

type ApprovalEnv = LocalSessionConfig & {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DB?: ApprovalDb;
};

type Input = {
  merchantId: string;
  quoteId: string;
  revision: number;
  snapshotSha256: string;
  idempotencyKey: string;
};

type Ledger = {
  approval_id: string;
  quote_id: string;
  revision_no: number;
  snapshot_sha256: string;
};

type Latest = {
  revision_no: number;
  snapshot_sha256: string;
};

export type ApprovalResult = Readonly<{
  approvalId: string;
  quoteId: string;
  merchantId: string;
  revision: number;
  snapshotSha256: string;
  replayed: boolean;
  paymentInitiated: false;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID_V4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const FIELDS = [
  'idempotencyKey',
  'merchantId',
  'quoteId',
  'revision',
  'snapshotSha256',
];

function parseInput(raw: unknown): Input {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw)
  ) {
    throw Error('APPROVAL_REQUEST_INVALID');
  }

  const value = raw as Record<string, unknown>;

  if (
    Object.keys(value).sort().join('|') !==
      FIELDS.join('|') ||
    typeof value.merchantId !== 'string' ||
    !ID.test(value.merchantId) ||
    typeof value.quoteId !== 'string' ||
    !ID.test(value.quoteId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    (value.revision as number) > 1000000 ||
    typeof value.snapshotSha256 !== 'string' ||
    !HASH.test(value.snapshotSha256) ||
    typeof value.idempotencyKey !== 'string' ||
    !UUID_V4.test(value.idempotencyKey)
  ) {
    throw Error('APPROVAL_REQUEST_INVALID');
  }

  return value as Input;
}

function output(
  input: Input,
  approvalId: string,
  replayed: boolean,
): ApprovalResult {
  return Object.freeze({
    approvalId,
    quoteId: input.quoteId,
    merchantId: input.merchantId,
    revision: input.revision,
    snapshotSha256: input.snapshotSha256,
    replayed,
    paymentInitiated: false as const,
  });
}

function matches(input: Input, row: Ledger): boolean {
  return (
    typeof row.approval_id === 'string' &&
    row.approval_id.length > 0 &&
    row.quote_id === input.quoteId &&
    row.revision_no === input.revision &&
    row.snapshot_sha256 === input.snapshotSha256
  );
}

async function findLedger(
  db: ApprovalDb,
  actorId: string,
  input: Input,
): Promise<Ledger | null> {
  return db.prepare(`
    SELECT
      approval_id, quote_id,
      revision_no, snapshot_sha256
    FROM approval_idempotency
    WHERE merchant_id = ?
      AND actor_id = ?
      AND idempotency_key = ?
    LIMIT 1
  `)
    .bind(
      input.merchantId,
      actorId,
      input.idempotencyKey,
    )
    .first<Ledger>();
}

/**
 * Internal-only approval operation.
 *
 * There is intentionally no HTTP endpoint.
 * PayPal is never called.
 */
export async function approveQuote(
  request: Request,
  env: ApprovalEnv | undefined,
  rawInput: unknown,
  testKeyset?: JWTVerifyGetKey,
): Promise<ApprovalResult> {
  const input = parseInput(rawInput);
  const db = env?.DB;

  if (!db || typeof db.batch !== 'function') {
    throw Error('APPROVAL_UNAVAILABLE');
  }

  // Authentication and tenant membership are mandatory.
  const actor = await authorizeMerchantApproval(
    request,
    env,
    input.merchantId,
    testKeyset,
  );

  let existing: Ledger | null;

  try {
    existing = await findLedger(
      db,
      actor.actorId,
      input,
    );
  } catch {
    throw Error('APPROVAL_UNAVAILABLE');
  }

  // Retried operations must match the original action.
  if (existing) {
    if (!matches(input, existing)) {
      throw Error('APPROVAL_IDEMPOTENCY_CONFLICT');
    }

    return output(input, existing.approval_id, true);
  }

  let latest: Latest | null;

  try {
    latest = await db.prepare(`
      SELECT r.revision_no, r.snapshot_sha256
      FROM quote_revisions r
      INNER JOIN quotes q
        ON q.id = r.quote_id
       AND q.merchant_id = r.merchant_id
      WHERE q.id = ?
        AND q.merchant_id = ?
      ORDER BY r.revision_no DESC
      LIMIT 1
    `)
      .bind(input.quoteId, input.merchantId)
      .first<Latest>();
  } catch {
    throw Error('APPROVAL_UNAVAILABLE');
  }

  if (
    !latest ||
    latest.revision_no !== input.revision ||
    latest.snapshot_sha256 !== input.snapshotSha256
  ) {
    throw Error('APPROVAL_STALE_OR_NOT_FOUND');
  }

  const approvalId = crypto.randomUUID();
  const auditId = crypto.randomUUID();

  // D1 transaction: all three records must commit.
  // Database triggers independently enforce:
  // - latest quote revision
  // - active authorized actor
  // - exactly one approval per quote
  // - matching immutable idempotency record
  try {
    const results = await db.batch([
      db.prepare(`
        INSERT INTO approvals (
          id, quote_id, merchant_id,
          revision_no, snapshot_sha256, approved_by
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        approvalId,
        input.quoteId,
        input.merchantId,
        input.revision,
        input.snapshotSha256,
        actor.actorId,
      ),

      db.prepare(`
        INSERT INTO approval_idempotency (
          merchant_id, actor_id,
          idempotency_key, approval_id,
          quote_id, revision_no, snapshot_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.merchantId,
        actor.actorId,
        input.idempotencyKey,
        approvalId,
        input.quoteId,
        input.revision,
        input.snapshotSha256,
      ),

      db.prepare(`
        INSERT INTO audit_events (
          id, merchant_id, action,
          actor_id, entity_id, metadata_json
        ) VALUES (
          ?, ?, 'QUOTE_APPROVED', ?, ?, ?
        )
      `).bind(
        auditId,
        input.merchantId,
        actor.actorId,
        input.quoteId,
        JSON.stringify({
          approvalId,
          revision: input.revision,
          snapshotSha256: input.snapshotSha256,
        }),
      ),
    ]);

    if (
      !Array.isArray(results) ||
      results.length !== 3 ||
      !results.every(r => r?.success === true)
    ) {
      throw Error('APPROVAL_BATCH_INVALID');
    }
  } catch {
    // Reconcile ambiguous outcomes and same-key races.
    let recovered: Ledger | null;

    try {
      recovered = await findLedger(
        db,
        actor.actorId,
        input,
      );
    } catch {
      throw Error('APPROVAL_OUTCOME_UNCERTAIN');
    }

    if (recovered) {
      if (!matches(input, recovered)) {
        throw Error('APPROVAL_IDEMPOTENCY_CONFLICT');
      }

      return output(
        input,
        recovered.approval_id,
        true,
      );
    }

    throw Error('APPROVAL_NOT_COMMITTED');
  }

  // Never report success without verifying the ledger.
  let committed: Ledger | null;

  try {
    committed = await findLedger(
      db,
      actor.actorId,
      input,
    );
  } catch {
    throw Error('APPROVAL_OUTCOME_UNCERTAIN');
  }

  if (
    !committed ||
    !matches(input, committed) ||
    committed.approval_id !== approvalId
  ) {
    throw Error('APPROVAL_OUTCOME_UNCERTAIN');
  }

  return output(input, approvalId, false);
}
