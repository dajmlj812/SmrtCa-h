-- Migration 017: Phase 8 — multi-tenant + multi-user foundation.
--
-- This migration lays the schema groundwork but does NOT enable Row
-- Level Security on data tables yet — that arrives in a follow-up
-- migration after every existing route is audited and every test
-- updated to seed a tenant context. Doing both in one shot would risk
-- silently broken queries.
--
-- What lands here:
--
--   1. `tenants` — one row per household / organization. Every data
--      table gains a nullable `tenant_id` FK pointing here, backfilled
--      to the seeded 'Default' tenant. NOT NULL + RLS in 018.
--
--   2. `memberships` — many-to-many users↔tenants with a role
--      (owner/admin/member/viewer). A user can belong to several
--      tenants; the active one is tracked on `sessions.active_tenant_id`.
--
--   3. `invitations` — owner/admin creates an invite (one-time token,
--      role + email hint). Accepting it creates a user (or links an
--      existing identity) and a membership.
--
--   4. `user_identities` — many-to-one identities↔user. One row per
--      auth-provider login (local password counts as `provider='local'`,
--      keyed off the existing users.password_hash). OIDC providers add
--      rows keyed by `(provider, provider_user_id)`. This is what lets
--      a single user log in via Google AND password AND Microsoft.
--
--   5. `auth_provider_configs` — runtime registry of configured login
--      providers. Settings UI writes here; the login page reads it via
--      GET /api/auth/providers. Local is always implicitly enabled and
--      never has a row.
--
--   6. `users` gains `email` and `name`. `email` is UNIQUE because a
--      user is one identity-anchor regardless of how many providers
--      they use. The existing singleton convention is retired.
--
--   7. `sessions` gains `active_tenant_id` so the session middleware
--      can SET LOCAL app.tenant_id once per request when RLS lands.
--
-- The seeded 'Default' tenant claims any pre-existing user as `owner`
-- and is set as their active tenant. Pre-existing data rows get their
-- `tenant_id` filled in by the backfill block at the bottom.

-- ── 1. tenants ─────────────────────────────────────────────
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- URL-safe handle, e.g. for future per-tenant paths. UNIQUE for
  -- distinct lookups even though we don't currently expose it.
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 2. users: add email/name, retire singleton ─────────────
ALTER TABLE users
  ADD COLUMN email text,
  ADD COLUMN name  text;
-- `email` is the user's canonical identity; UNIQUE prevents two rows
-- with the same email even via different providers. We allow NULL on
-- the column so the upgrade path can move existing single-user installs
-- forward without forcing a value; the API requires it for new users.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email))
  WHERE email IS NOT NULL;

-- ── 3. memberships ─────────────────────────────────────────
CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE INDEX memberships_tenant_idx ON memberships (tenant_id);

-- ── 4. invitations ─────────────────────────────────────────
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Free-form hint; we don't email anything in the self-hosted shape.
  -- The invite token in the URL is what authenticates the accept call.
  email_hint  text,
  role        text NOT NULL CHECK (role IN ('admin','member','viewer')),
  -- Token is the URL-safe random opaque string from
  -- crypto.randomBytes(24).toString('base64url'); stored as-is.
  token       text NOT NULL UNIQUE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_tenant_idx ON invitations (tenant_id)
  WHERE accepted_at IS NULL;

-- ── 5. user_identities ─────────────────────────────────────
CREATE TABLE user_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- e.g. 'local', 'oidc:google', 'oidc:microsoft', 'oidc:github',
  -- 'oidc:<config_id>' for generic OIDC, 'saml:<config_id>'.
  provider          text NOT NULL,
  -- Provider's own user id (sub claim for OIDC, NameID for SAML).
  -- For 'local', this is the user's email at signup time.
  provider_user_id  text NOT NULL,
  email             text,
  display_name      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- ── 6. auth_provider_configs ───────────────────────────────
CREATE TABLE auth_provider_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('oidc','saml')),
  -- Provider key — 'google', 'microsoft', 'github', or 'oidc:<slug>'
  -- for generic. Used as the URL segment for the callback route.
  slug        text NOT NULL UNIQUE,
  display_name text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  -- Free-form per-provider config (client_id, client_secret,
  -- discovery_url, scopes, etc). The route handlers know the keys.
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 7. sessions: add active_tenant_id ──────────────────────
ALTER TABLE sessions
  ADD COLUMN active_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL;

-- ── 8. tenant_id on data tables (nullable for now) ────────
-- All user-data tables get a tenant_id with a default that points at
-- the seeded Default tenant. Backfill runs in the DO block below. RLS
-- + NOT NULL land in a follow-up migration.
ALTER TABLE accounts                 ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE transactions             ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE attachments              ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE categories               ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE category_suggestions     ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE import_batches           ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE normalization_rules      ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE transaction_splits       ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE recurring_suggestions    ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE budgets                  ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE savings_goals            ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE bills                    ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE recurring_income         ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE holdings                 ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE vehicles                 ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE commute_routes           ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE route_vehicle_assignments ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE fuel_prices              ADD COLUMN tenant_id uuid REFERENCES tenants(id);

-- ── 9. Seed Default tenant + backfill ──────────────────────
DO $$
DECLARE
  default_tenant_id uuid;
  legacy_user_id uuid;
BEGIN
  -- Create the Default tenant (idempotent on re-run via the slug UNIQUE).
  INSERT INTO tenants (name, slug)
    VALUES ('Default', 'default')
    RETURNING id INTO default_tenant_id;

  -- Backfill tenant_id on every data table.
  UPDATE accounts                 SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE transactions             SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE attachments              SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE categories               SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE category_suggestions     SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE import_batches           SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE normalization_rules      SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE transaction_splits       SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE recurring_suggestions    SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE budgets                  SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE savings_goals            SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE bills                    SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE recurring_income         SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE holdings                 SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE vehicles                 SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE commute_routes           SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE route_vehicle_assignments SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
  UPDATE fuel_prices              SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;

  -- Backfill: existing legacy single user (if any) becomes owner of
  -- Default and gets a 'local' identity pointed at password_hash. Their
  -- active_tenant_id on any current session also gets filled.
  SELECT id INTO legacy_user_id FROM users ORDER BY created_at LIMIT 1;
  IF legacy_user_id IS NOT NULL THEN
    -- Name fallback: 'Owner' if not set later via PATCH /me.
    UPDATE users SET name = COALESCE(name, 'Owner') WHERE id = legacy_user_id;
    INSERT INTO memberships (tenant_id, user_id, role)
      VALUES (default_tenant_id, legacy_user_id, 'owner')
      ON CONFLICT (tenant_id, user_id) DO NOTHING;
    INSERT INTO user_identities (user_id, provider, provider_user_id)
      VALUES (legacy_user_id, 'local', legacy_user_id::text)
      ON CONFLICT (provider, provider_user_id) DO NOTHING;
    UPDATE sessions SET active_tenant_id = default_tenant_id
      WHERE user_id = legacy_user_id AND active_tenant_id IS NULL;
  END IF;
END $$;
