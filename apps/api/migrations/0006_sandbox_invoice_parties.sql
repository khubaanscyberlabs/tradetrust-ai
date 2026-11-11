-- TradeTrust 09P-03: local Sandbox demo party bindings.
-- This is NOT PayPal KYC, account ownership verification, or buyer consent.
-- Must not be deployed remotely or populated without separate authorization.
CREATE TABLE sandbox_invoice_parties (
  approval_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL CHECK(revision_no > 0),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64),
  invoicer_email TEXT NOT NULL CHECK(length(invoicer_email) BETWEEN 5 AND 254),
  invoicer_business_name TEXT NOT NULL CHECK(length(invoicer_business_name) BETWEEN 1 AND 120),
  buyer_email TEXT NOT NULL CHECK(length(buyer_email) BETWEEN 5 AND 254),
  origin TEXT NOT NULL DEFAULT 'LOCAL_OPERATOR_REGISTERED'
    CHECK(origin = 'LOCAL_OPERATOR_REGISTERED'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  FOREIGN KEY (quote_id, merchant_id, revision_no, snapshot_sha256)
    REFERENCES quote_revisions(quote_id, merchant_id, revision_no, snapshot_sha256)
    ON DELETE RESTRICT,
  CHECK(lower(invoicer_email) != lower(buyer_email))
);

CREATE TRIGGER sandbox_invoice_parties_must_match_approval
BEFORE INSERT ON sandbox_invoice_parties
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM approvals a
    JOIN quote_revisions r ON r.quote_id = a.quote_id
      AND r.merchant_id = a.merchant_id
      AND r.revision_no = a.revision_no
      AND r.snapshot_sha256 = a.snapshot_sha256
    WHERE a.id = NEW.approval_id
      AND a.merchant_id = NEW.merchant_id
      AND a.quote_id = NEW.quote_id
      AND a.revision_no = NEW.revision_no
      AND a.snapshot_sha256 = NEW.snapshot_sha256
      AND r.revision_no = (
        SELECT MAX(z.revision_no) FROM quote_revisions z
        WHERE z.quote_id = a.quote_id AND z.merchant_id = a.merchant_id
      )
  ) THEN RAISE(ABORT, 'sandbox party record must match latest approved revision') END;
END;

CREATE TRIGGER sandbox_invoice_parties_no_update
BEFORE UPDATE ON sandbox_invoice_parties
BEGIN
  SELECT RAISE(ABORT, 'sandbox party binding is immutable');
END;
CREATE TRIGGER sandbox_invoice_parties_no_delete
BEFORE DELETE ON sandbox_invoice_parties
BEGIN
  SELECT RAISE(ABORT, 'sandbox party binding cannot be deleted');
END;
