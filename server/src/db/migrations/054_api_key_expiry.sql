-- F-12 (security audit 2026-05-25) — optional expiration for API keys.
--
-- Today API keys live forever unless explicitly revoked. A leaked key
-- in a public repo / a stale developer laptop / a discarded CI config
-- keeps working until someone notices. An optional expires_at bounds
-- the leak window without forcing every user to rotate.
--
-- Defaults to NULL (no expiry, current behavior). The lookupKey()
-- function in auth/api-keys.ts rejects keys past their expires_at
-- the same way it does for revoked_at — neither route handlers nor
-- the auth middleware need to know about this column directly.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;

-- The lookupKey() WHERE clause filters by both expires_at and
-- revoked_at, so the existing api_keys_key_hash index covers us; no
-- new index needed.

COMMENT ON COLUMN api_keys.expires_at IS
  'Optional expiry: when set and now() > expires_at, lookupKey() returns null. NULL = no expiry (F-12).';
