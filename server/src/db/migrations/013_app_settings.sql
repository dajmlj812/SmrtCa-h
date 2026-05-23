-- Migration 013: app_settings — runtime-editable config managed via the
-- GUI instead of .env.
--
-- Each row is one (key, value) pair. A non-null DB value overrides the
-- equivalent process.env at read time. NULL or absent → fall back to env,
-- and if env is also empty, the feature is "not configured".
--
-- `is_secret` controls masking on the GET response: secret values come
-- back as `••••XXXX` (last 4 chars) so the full credential never
-- round-trips back to the client.
--
-- Storage is plain text. The DB lives on the same host as .env and the
-- attachment files; the trust boundary is the same. Encryption at rest
-- for the database is documented in the admin guide.

CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      text,
  is_secret  boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
