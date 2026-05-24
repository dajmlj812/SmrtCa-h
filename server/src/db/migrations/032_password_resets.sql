-- Migration 032 (0.16.2): password reset tokens.
--
-- Shape mirrors `email_verifications` (migration 031) — same
-- single-use, expires-at, kept-after-consume pattern. The two
-- tables stay separate because:
--
--   • The TTLs differ (1h for resets vs 24h for verification —
--     password reset is more sensitive, so we want a tighter
--     window).
--   • The actions are independent: a user can request a reset
--     without affecting their email_verified_at, and verify
--     their email without invalidating any reset tokens.
--   • Auditing the two flows separately is cleaner when reading
--     `audit_log`.

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- URL-safe bearer token. Stored raw because the table is
  -- access-controlled and the values are short-lived; matches
  -- the email_verifications pattern.
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  -- NULL until the user submits the new password. Consumed rows
  -- are kept so the audit log + funnel metrics (how many resets
  -- requested vs completed) stay queryable.
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Cleanup-job index: "expired tokens that were never used."
CREATE INDEX password_resets_expires_at_idx
  ON password_resets (expires_at)
  WHERE consumed_at IS NULL;
