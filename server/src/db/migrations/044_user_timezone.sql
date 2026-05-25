-- Migration 044 (0.18.3): per-user timezone preference.
--
-- Stored as an IANA timezone string (e.g. 'America/New_York',
-- 'Europe/London', 'Asia/Tokyo'). NULL = follow the browser's
-- detected timezone (the prior behavior — no surprises for users
-- who never open the new Profile modal).
--
-- We do NOT validate the value with a CHECK constraint because
-- the canonical IANA list is moved/renamed periodically; instead
-- the route validates against the runtime
-- `Intl.supportedValuesOf('timeZone')` list, which tracks the
-- bundled ICU data.

ALTER TABLE users
  ADD COLUMN timezone text;

COMMENT ON COLUMN users.timezone IS
  '0.18.3 — IANA timezone the user prefers for displayed timestamps. NULL falls back to the browser-detected TZ.';
