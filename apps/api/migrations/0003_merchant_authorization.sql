-- TradeTrust AI: Merchant authorization foundation.
-- Identity provider: Cloudflare Access.
-- No passwords, access tokens or email addresses stored.

CREATE TABLE merchant_actors (
  id TEXT PRIMARY KEY,

  provider TEXT NOT NULL
    CHECK(provider = 'CLOUDFLARE_ACCESS'),

  issuer TEXT NOT NULL
    CHECK(length(issuer) BETWEEN 15 AND 250),

  subject TEXT NOT NULL
    CHECK(length(subject) BETWEEN 1 AND 250),

  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK(status IN ('ACTIVE', 'REVOKED')),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(provider, issuer, subject)
);

CREATE TABLE merchant_memberships (
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,

  role TEXT NOT NULL
    CHECK(role IN ('OWNER', 'MANAGER', 'STAFF')),

  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK(status IN ('ACTIVE', 'REVOKED')),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY(merchant_id, actor_id),

  FOREIGN KEY(merchant_id)
    REFERENCES merchants(id) ON DELETE RESTRICT,

  FOREIGN KEY(actor_id)
    REFERENCES merchant_actors(id) ON DELETE RESTRICT
);

CREATE INDEX idx_memberships_actor
ON merchant_memberships(actor_id, status);

-- Defense in depth:
-- Even if application authorization is accidentally
-- bypassed, unauthorized actors cannot insert approvals.

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
      AND ma.provider = 'CLOUDFLARE_ACCESS'
      AND mm.role IN ('OWNER', 'MANAGER')
  )
  THEN RAISE(
    ABORT,
    'merchant approval requires active authorized human'
  ) END;
END;

-- Identity bindings cannot be reassigned.

CREATE TRIGGER actors_identity_immutable
BEFORE UPDATE OF id, provider, issuer, subject
ON merchant_actors
BEGIN
  SELECT RAISE(
    ABORT,
    'identity binding immutable'
  );
END;

CREATE TRIGGER memberships_identity_immutable
BEFORE UPDATE OF merchant_id, actor_id
ON merchant_memberships
BEGIN
  SELECT RAISE(
    ABORT,
    'membership binding immutable'
  );
END;

-- Keep authorization history. Revoke instead.

CREATE TRIGGER actors_no_delete
BEFORE DELETE ON merchant_actors
BEGIN
  SELECT RAISE(
    ABORT,
    'revoke actor instead of deleting'
  );
END;

CREATE TRIGGER memberships_no_delete
BEFORE DELETE ON merchant_memberships
BEGIN
  SELECT RAISE(
    ABORT,
    'revoke membership instead of deleting'
  );
END;
