-- Local demo auth expansion. Apply locally only after backup and review.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE tt_actor_preservation AS SELECT * FROM merchant_actors;
DROP TRIGGER approval_authorized_human;
DROP TRIGGER actors_no_delete;
DROP TABLE merchant_actors;
CREATE TABLE merchant_actors (
  id TEXT PRIMARY KEY,

  provider TEXT NOT NULL
    CHECK(provider IN ('CLOUDFLARE_ACCESS', 'LOCAL_SESSION')),

  issuer TEXT NOT NULL
    CHECK(length(issuer) BETWEEN 15 AND 250),

  subject TEXT NOT NULL
    CHECK(length(subject) BETWEEN 1 AND 250),

  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK(status IN ('ACTIVE', 'REVOKED')),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(provider, issuer, subject)
);

INSERT INTO merchant_actors(id,provider,issuer,subject,status,created_at)
SELECT id,provider,issuer,subject,status,created_at FROM tt_actor_preservation;
DROP TABLE tt_actor_preservation;
CREATE TRIGGER actors_identity_immutable
BEFORE UPDATE OF id, provider, issuer, subject
ON merchant_actors
BEGIN
  SELECT RAISE(
    ABORT,
    'identity binding immutable'
  );
END;

CREATE TRIGGER actors_no_delete
BEFORE DELETE ON merchant_actors
BEGIN
  SELECT RAISE(
    ABORT,
    'revoke actor instead of deleting'
  );
END;

CREATE TRIGGER approval_authorized_human
BEFORE INSERT ON approvals
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM merchant_memberships mm
    JOIN merchant_actors ma ON ma.id = mm.actor_id
    WHERE mm.merchant_id = NEW.merchant_id
      AND mm.actor_id = NEW.approved_by
      AND mm.status = 'ACTIVE'
      AND ma.status = 'ACTIVE'
      AND ma.provider IN ('CLOUDFLARE_ACCESS','LOCAL_SESSION')
      AND mm.role IN ('OWNER', 'MANAGER')
  )
  THEN RAISE(
    ABORT,
    'merchant approval requires active authorized human'
  ) END;
END;


CREATE TABLE local_merchant_sessions (
 actor_id TEXT PRIMARY KEY REFERENCES merchant_actors(id) ON DELETE RESTRICT,
 token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64),
 credential_sha256 TEXT NOT NULL CHECK(length(credential_sha256)=64),
 expires_at INTEGER NOT NULL CHECK(expires_at>0)
);
