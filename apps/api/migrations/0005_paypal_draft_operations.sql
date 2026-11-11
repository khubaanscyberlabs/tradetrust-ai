-- TradeTrust AI: PayPal Sandbox draft operation ledger.
--
-- This table stores operation identity and expected amounts.
-- No credentials, access tokens, or buyer emails.
--
-- It DOES NOT make PayPal API requests.
--
-- PREPARED:
--   Stable operation and request identifiers are recorded.
--
-- UNCERTAIN:
--   Operation has been claimed before external POST.
--   A timeout or crash requires reconciliation.
--
-- DRAFT_CREATED:
--   PayPal invoice ID has been verified and recorded.

CREATE TABLE paypal_draft_operations (
  id TEXT PRIMARY KEY,

  approval_id TEXT NOT NULL UNIQUE,

  merchant_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,

  revision_no INTEGER NOT NULL
    CHECK(revision_no > 0),

  snapshot_sha256 TEXT NOT NULL
    CHECK(length(snapshot_sha256) = 64),

  request_body_sha256 TEXT NOT NULL
    CHECK(length(request_body_sha256) = 64),

  paypal_request_id TEXT NOT NULL UNIQUE
    CHECK(length(paypal_request_id) = 36),

  invoice_number TEXT NOT NULL UNIQUE
    CHECK(
      length(invoice_number) = 23
      AND substr(invoice_number, 1, 3) = 'TT-'
    ),

  expected_total_cents INTEGER NOT NULL
    CHECK(
      expected_total_cents BETWEEN 1 AND 100000000
    ),

  currency TEXT NOT NULL
    CHECK(currency = 'USD'),

  status TEXT NOT NULL DEFAULT 'PREPARED'
    CHECK(
      status IN (
        'PREPARED',
        'UNCERTAIN',
        'DRAFT_CREATED'
      )
    ),

  paypal_invoice_id TEXT UNIQUE
    CHECK(
      paypal_invoice_id IS NULL
      OR length(paypal_invoice_id) BETWEEN 1 AND 128
    ),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY(approval_id)
    REFERENCES approvals(id) ON DELETE RESTRICT,

  FOREIGN KEY(
    quote_id, merchant_id,
    revision_no, snapshot_sha256
  )
    REFERENCES quote_revisions(
      quote_id, merchant_id,
      revision_no, snapshot_sha256
    ) ON DELETE RESTRICT,

  CHECK(
    (
      status = 'DRAFT_CREATED'
      AND paypal_invoice_id IS NOT NULL
    )
    OR
    (
      status IN ('PREPARED', 'UNCERTAIN')
      AND paypal_invoice_id IS NULL
    )
  )
);

-- Only a real approved quote with an identical
-- merchant, revision, hash and total can initialize
-- an invoice operation.

CREATE TRIGGER paypal_draft_must_match_approval
BEFORE INSERT ON paypal_draft_operations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM approvals a
    JOIN quote_revisions r
      ON r.quote_id = a.quote_id
     AND r.merchant_id = a.merchant_id
     AND r.revision_no = a.revision_no
     AND r.snapshot_sha256 = a.snapshot_sha256

    WHERE a.id = NEW.approval_id
      AND a.quote_id = NEW.quote_id
      AND a.merchant_id = NEW.merchant_id
      AND a.revision_no = NEW.revision_no
      AND a.snapshot_sha256 = NEW.snapshot_sha256
      AND r.total_cents = NEW.expected_total_cents
  )
  THEN RAISE(
    ABORT,
    'draft operation requires matching approval and amount'
  ) END;
END;

-- Idempotency identifiers and financial bindings
-- cannot be modified after insertion.

CREATE TRIGGER paypal_draft_update_guard
BEFORE UPDATE ON paypal_draft_operations
BEGIN
  SELECT CASE WHEN
    NEW.id != OLD.id
    OR NEW.approval_id != OLD.approval_id
    OR NEW.merchant_id != OLD.merchant_id
    OR NEW.quote_id != OLD.quote_id
    OR NEW.revision_no != OLD.revision_no
    OR NEW.snapshot_sha256 != OLD.snapshot_sha256
    OR NEW.request_body_sha256 != OLD.request_body_sha256
    OR NEW.paypal_request_id != OLD.paypal_request_id
    OR NEW.invoice_number != OLD.invoice_number
    OR NEW.expected_total_cents != OLD.expected_total_cents
    OR NEW.currency != OLD.currency
    OR NEW.created_at != OLD.created_at
  THEN RAISE(
    ABORT,
    'draft operation identity immutable'
  ) END;

  SELECT CASE WHEN NOT (
    (
      OLD.status = 'PREPARED'
      AND NEW.status = 'UNCERTAIN'
      AND NEW.paypal_invoice_id IS NULL
    )
    OR
    (
      OLD.status = 'UNCERTAIN'
      AND NEW.status = 'DRAFT_CREATED'
      AND NEW.paypal_invoice_id IS NOT NULL
    )
  )
  THEN RAISE(
    ABORT,
    'invalid draft status transition'
  ) END;
END;

CREATE TRIGGER paypal_draft_no_delete
BEFORE DELETE ON paypal_draft_operations
BEGIN
  SELECT RAISE(
    ABORT,
    'draft operation cannot be deleted'
  );
END;
