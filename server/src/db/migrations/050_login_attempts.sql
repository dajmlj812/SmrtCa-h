-- F-01 (security audit 2026-05-25) — login brute-force protection.
--
-- Records failed-login attempts keyed by (email, ip) so the login
-- handler can count recent failures and refuse with 429 once over
-- the threshold. Successful login deletes the user's rows so a
-- legitimate user doesn't accumulate strikes.
--
-- We don't extend `sessions` for this because we want to track
-- attempts that DON'T produce a session, and we want a separate
-- janitor pass that runs out the rows older than the rate-limit
-- window.

CREATE TABLE IF NOT EXISTS login_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercased email (we lower at insert) so case variants don't
  -- bypass the limit. Stored as text, not a FK, because the email
  -- may not match any existing user.
  email_lower  text NOT NULL,
  -- Source IP. May be IPv4 or IPv6 string form; we don't parse it.
  ip           text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  -- success=true rows exist only briefly: we insert on attempt then
  -- DELETE all rows for (email, ip) on successful login. The flag
  -- is here for completeness / debugging if we ever audit it.
  success      boolean NOT NULL DEFAULT false
);

-- Index for the rate-limit query: "count recent failed attempts for
-- this (email, ip)". The WHERE clause filters by attempted_at so a
-- partial index on attempted_at lookups is efficient.
CREATE INDEX IF NOT EXISTS login_attempts_lookup_idx
  ON login_attempts (email_lower, ip, attempted_at DESC);

-- For the janitor that prunes old rows.
CREATE INDEX IF NOT EXISTS login_attempts_attempted_at_idx
  ON login_attempts (attempted_at);

COMMENT ON TABLE login_attempts IS
  'Rolling per-(email,ip) login-attempt log for brute-force protection. F-01.';
