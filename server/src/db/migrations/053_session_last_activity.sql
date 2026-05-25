-- F-11 (security audit 2026-05-25) — server-side idle timeout column.
--
-- Today the only enforced session-end-of-life is the 7-day absolute
-- `expires_at`. The frontend has a client-side idle hook
-- (WEB_INACTIVITY_TIMEOUT_MINUTES), but a closed-browser user with
-- a hostile-script extension OR a stolen session cookie running on
-- a separate device keeps that session valid for 7 full days.
--
-- The new column tracks the most recent authenticated request on
-- each session. The auth middleware bumps it on every hit (cheap:
-- one UPDATE on a primary-key row), and the session-load query
-- treats sessions older than the configured idle window as expired.
--
-- Default value: now() at creation; the application layer keeps it
-- fresh after.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now();

-- For the idle-timeout reject scan when the user revisits after a
-- long pause.
CREATE INDEX IF NOT EXISTS sessions_last_activity_idx
  ON sessions (last_activity_at);

COMMENT ON COLUMN sessions.last_activity_at IS
  'Bumped on every authenticated request. Compared against the WEB_INACTIVITY_TIMEOUT_MINUTES setting at session-load time (F-11).';
