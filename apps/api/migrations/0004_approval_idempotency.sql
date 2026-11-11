-- TradeTrust AI: Immutable approval idempotency ledger.
-- No customer PII or payment credentials.

CREATE TABLE approval_idempotency (
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,

  idempotency_key TEXT NOT NULL
    CHECK(length(idempotency_key) = 36),

  approval_id TEXT NOT NULL UNIQUE,

  quote_id TEXT NOT NULL,

  revision_no INTEGER NOT NULL
    CHECK(revision_no > 0),

  snapshot_sha256 TEXT NOT NULL
    CHECK(length(snapshot_sha256) = 64),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY(
    merchant_id, actor_id, idempotency_key
  ),

  FOREIGN KEY(merchant_id, actor_id)
    REFERENCES merchant_memberships(
      merchant_id, actor_id
    ) ON DELETE RESTRICT,

  FOREIGN KEY(approval_id)
    REFERENCES approvals(id) ON DELETE RESTRICT,

  FOREIGN KEY(
    quote_id, merchant_id,
    revision_no, snapshot_sha256
  )
    REFERENCES quote_revisions(
      quote_id, merchant_id,
      revision_no, snapshot_sha256
    ) ON DELETE RESTRICT
);

CREATE TRIGGER approval_idempotency_matches_approval
BEFORE INSERT ON approval_idempotency
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM approvals a
    WHERE a.id = NEW.approval_id
      AND a.quote_id = NEW.quote_id
      AND a.merchant_id = NEW.merchant_id
      AND a.revision_no = NEW.revision_no
      AND a.snapshot_sha256 = NEW.snapshot_sha256
      AND a.approved_by = NEW.actor_id
  )
  THEN RAISE(
    ABORT,
    'idempotency record must match approved quote'
  ) END;
END;

CREATE TRIGGER approval_idempotency_no_update
BEFORE UPDATE ON approval_idempotency
BEGIN
  SELECT RAISE(
    ABORT,
    'approval idempotency is append-only'
  );
END;

CREATE TRIGGER approval_idempotency_no_delete
BEFORE DELETE ON approval_idempotency
BEGIN
  SELECT RAISE(
    ABORT,
    'approval idempotency is append-only'
  );
END;
