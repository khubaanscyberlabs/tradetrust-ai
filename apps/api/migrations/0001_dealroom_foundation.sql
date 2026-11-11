-- TradeTrust AI — Local-first Dealroom Foundation
-- No customer information or payment credentials.

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
    CHECK(length(display_name) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dealrooms (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK(status IN ('OPEN', 'CLOSED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(id, merchant_id),

  FOREIGN KEY(merchant_id)
    REFERENCES merchants(id) ON DELETE RESTRICT
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  dealroom_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(id, merchant_id),

  FOREIGN KEY(dealroom_id, merchant_id)
    REFERENCES dealrooms(id, merchant_id)
    ON DELETE RESTRICT
);

CREATE TABLE quote_revisions (
  quote_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL
    CHECK(revision_no > 0),

  currency TEXT NOT NULL CHECK(currency = 'USD'),

  subtotal_cents INTEGER NOT NULL
    CHECK(subtotal_cents >= 0),

  discount_cents INTEGER NOT NULL
    CHECK(discount_cents >= 0
      AND discount_cents <= subtotal_cents),

  shipping_cents INTEGER NOT NULL
    CHECK(shipping_cents >= 0),

  total_cents INTEGER NOT NULL
    CHECK(total_cents > 0 AND
      total_cents =
        subtotal_cents - discount_cents + shipping_cents),

  snapshot_json TEXT NOT NULL
    CHECK(json_valid(snapshot_json)),

  snapshot_sha256 TEXT NOT NULL
    CHECK(length(snapshot_sha256) = 64),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY(quote_id, revision_no),

  UNIQUE(
    quote_id,
    merchant_id,
    revision_no,
    snapshot_sha256
  ),

  FOREIGN KEY(quote_id, merchant_id)
    REFERENCES quotes(id, merchant_id)
    ON DELETE RESTRICT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE,
  merchant_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,

  snapshot_sha256 TEXT NOT NULL
    CHECK(length(snapshot_sha256) = 64),

  approved_by TEXT NOT NULL
    CHECK(length(approved_by) > 0),

  approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY(
    quote_id,
    merchant_id,
    revision_no,
    snapshot_sha256
  )
  REFERENCES quote_revisions(
    quote_id,
    merchant_id,
    revision_no,
    snapshot_sha256
  )
  ON DELETE RESTRICT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,

  action TEXT NOT NULL CHECK(action IN (
    'QUOTE_PROPOSED',
    'QUOTE_REVISED',
    'QUOTE_APPROVED',
    'QUOTE_REJECTED',
    'SECURITY_REJECTED'
  )),

  actor_id TEXT NOT NULL CHECK(length(actor_id) > 0),
  entity_id TEXT NOT NULL,

  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(metadata_json)),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY(merchant_id)
    REFERENCES merchants(id) ON DELETE RESTRICT
);

CREATE INDEX idx_dealrooms_merchant
  ON dealrooms(merchant_id, created_at);

CREATE INDEX idx_quotes_dealroom
  ON quotes(dealroom_id, created_at);

CREATE INDEX idx_audit_merchant
  ON audit_events(merchant_id, created_at);

-- Revisions, approvals and audit events are append-only.

CREATE TRIGGER quote_revisions_no_update
BEFORE UPDATE ON quote_revisions
BEGIN
  SELECT RAISE(ABORT, 'quote revisions are append-only');
END;

CREATE TRIGGER quote_revisions_no_delete
BEFORE DELETE ON quote_revisions
BEGIN
  SELECT RAISE(ABORT, 'quote revisions are append-only');
END;

CREATE TRIGGER approvals_no_update
BEFORE UPDATE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are append-only');
END;

CREATE TRIGGER approvals_no_delete
BEFORE DELETE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are append-only');
END;

CREATE TRIGGER audit_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
