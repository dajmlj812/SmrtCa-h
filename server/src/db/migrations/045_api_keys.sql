-- Migration 045 (0.18.4): per-user API keys for the public read-only API.
--
-- Goal: each tenant member can mint one or more API keys to access
-- their own SmrtCash data over HTTP without going through the
-- session-cookie flow. Read-only for v0.18.4; write scopes are
-- deferred until there's actual demand.
--
-- Storage model: we persist the SHA-256 of the secret token, not the
-- token itself, so a database leak doesn't expose live credentials.
-- The first 12 chars of the displayable form ("smrt_xxxx") are also
-- stored as `key_prefix` so the UI can show "smrt_abc123…" without
-- the user keeping a copy of the full token.
--
-- `tenant_id` is nullable so the user can mint a key bound to a
-- specific tenant (when they belong to multiple households) OR a
-- "follow my active tenant" key. v0.18.4 always pins to one tenant
-- at create time; NULL is reserved for a future "multi-tenant key"
-- if it's ever useful.

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash      text NOT NULL,
  key_prefix    text NOT NULL,
  label         text NOT NULL,
  scopes        text NOT NULL DEFAULT 'read'
                CHECK (scopes IN ('read')),
  last_used_at  timestamptz,
  last_used_ip  text,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX api_keys_key_hash_idx ON api_keys (key_hash);
CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);

COMMENT ON TABLE api_keys IS
  '0.18.4 — per-user secrets for the public read-only API. Token hashed (SHA-256); prefix stored for display.';
COMMENT ON COLUMN api_keys.tenant_id IS
  'Pins the key to a specific tenant. NULL is reserved for a future multi-tenant key shape; v0.18.4 always sets this at create time.';
COMMENT ON COLUMN api_keys.scopes IS
  'Currently always ''read''. Write scopes deferred until there''s a real use case + plan for safe defaults.';
