-- Migration 031 (0.16.0): public signup + email verification.
--
-- Two changes:
--
-- 1) users.email_verified_at — nullable timestamp. NULL means the
--    user has not clicked their verification link yet; login is
--    refused for them. Existing users (self-host operators created
--    via /api/auth/setup, invited tenant members, OIDC users) are
--    backfilled to their created_at: anyone already in the system
--    is implicitly trusted.
--
-- 2) email_verifications — short-lived bearer tokens minted by
--    /api/auth/signup and consumed by /api/auth/verify-email.
--    One unconsumed token per user at a time; expires 24h after
--    issue. Consumed tokens are kept (not deleted) for audit
--    purposes — the count of issued vs consumed verifications is a
--    useful signup-funnel metric.

ALTER TABLE users
  ADD COLUMN email_verified_at timestamptz;

-- Anyone already in the database predates the verification regime;
-- treat them as verified.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE email_verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The opaque bearer token sent in the verification URL. URL-safe
  -- random; we store the raw value (not a hash) because it's
  -- single-use and short-lived; the table is access-controlled.
  token        text NOT NULL UNIQUE,
  -- Hard expiry. Routes reject any token where now() > expires_at.
  expires_at   timestamptz NOT NULL,
  -- NULL until /api/auth/verify-email accepts the token. Once
  -- non-null the row is inert — a replay attempt returns
  -- "already verified" rather than re-running the side effects.
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The hot path is "look up the row by token from the URL"; the
-- UNIQUE constraint above gives us that index. A second narrow
-- index helps the cleanup query that purges expired-but-unconsumed
-- rows (a future operator script; not wired in 0.16.0).
CREATE INDEX email_verifications_expires_at_idx
  ON email_verifications (expires_at)
  WHERE consumed_at IS NULL;
