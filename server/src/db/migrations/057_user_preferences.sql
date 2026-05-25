-- 0.18.14 — Per-user UI preferences.
--
-- One JSONB column on users keeps this simple. The dashboard layout
-- is the first consumer; future per-user prefs (theme, default
-- account, etc.) live here too. Keeping prefs flat in JSONB rather
-- than spinning a separate table because:
--   • The shape is fluid (every new widget adds a key).
--   • One read per user-session is enough; no need for indexed
--     querying across columns.
--   • Easy to merge-update (jsonb || jsonb) without schema migrations
--     for each new pref.
--
-- Cascade rule: belongs to users, so ON DELETE behavior is moot
-- (preferences live in the same row as the user; deleting the user
-- deletes the prefs naturally).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

-- A small sanity guard. Prefs shouldn't grow unbounded — 32 KB is
-- 10× what a reasonable dashboard layout needs, and stops a malicious
-- or buggy client from pushing megabytes per user.
ALTER TABLE users
  ADD CONSTRAINT users_preferences_size_chk
  CHECK (octet_length(preferences::text) <= 32768);
