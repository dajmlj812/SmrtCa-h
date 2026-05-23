-- Migration 005: Phase 5 — single-user authentication + attachment encryption.
--
-- Three changes:
--
-- 1. `users` table. Single-row by app convention; the auth route refuses
--    setup once any row exists. Password is an Argon2id hash.
--
-- 2. `sessions` table. Each row is one authenticated session; the
--    session id (a 32-byte random token, base64-encoded in the cookie)
--    is the primary key. Expiry is stored explicitly so the cookie
--    `Max-Age` and the server-side check stay in lockstep.
--
-- 3. `attachments.encryption_version smallint`. v=0 (default) means
--    plaintext on disk — that's every file written before this release.
--    v=1 means AES-256-GCM with a 12-byte random IV prefix and a 16-byte
--    GCM tag suffix. The read path branches on this column so existing
--    uploads keep working and only NEW uploads are encrypted.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE sessions (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
-- Used by the periodic cleanup that prunes expired rows.
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

ALTER TABLE attachments
  ADD COLUMN encryption_version smallint NOT NULL DEFAULT 0
    CHECK (encryption_version IN (0, 1));
