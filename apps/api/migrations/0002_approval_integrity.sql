-- TradeTrust AI: Approval integrity
-- Database-level protections for commercial agreements.

-- Approval must reference the latest existing revision.
CREATE TRIGGER approval_must_target_latest_revision
BEFORE INSERT ON approvals
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM quote_revisions r
    WHERE r.quote_id = NEW.quote_id
      AND r.merchant_id = NEW.merchant_id
      AND r.revision_no = NEW.revision_no
      AND r.snapshot_sha256 = NEW.snapshot_sha256
      AND r.revision_no = (
        SELECT MAX(latest.revision_no)
        FROM quote_revisions latest
        WHERE latest.quote_id = NEW.quote_id
      )
  )
  THEN RAISE(
    ABORT,
    'approval requires latest quote revision'
  ) END;
END;

-- Revision numbers start at 1 and cannot skip numbers.
CREATE TRIGGER quote_revision_must_be_sequential
BEFORE INSERT ON quote_revisions
BEGIN
  SELECT CASE WHEN NEW.revision_no != COALESCE(
    (
      SELECT MAX(r.revision_no) + 1
      FROM quote_revisions r
      WHERE r.quote_id = NEW.quote_id
    ),
    1
  )
  THEN RAISE(
    ABORT,
    'non-sequential quote revision'
  ) END;
END;

-- After approval, no further revisions may be appended.
CREATE TRIGGER quote_no_revisions_after_approval
BEFORE INSERT ON quote_revisions
WHEN EXISTS (
  SELECT 1 FROM approvals a
  WHERE a.quote_id = NEW.quote_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'approved quote is frozen'
  );
END;

-- Merchant ownership and dealroom assignment are immutable.
CREATE TRIGGER quote_identity_immutable
BEFORE UPDATE OF id, merchant_id, dealroom_id
ON quotes
BEGIN
  SELECT RAISE(
    ABORT,
    'quote identity is immutable'
  );
END;

CREATE TRIGGER dealroom_identity_immutable
BEFORE UPDATE OF id, merchant_id
ON dealrooms
BEGIN
  SELECT RAISE(
    ABORT,
    'dealroom identity is immutable'
  );
END;
