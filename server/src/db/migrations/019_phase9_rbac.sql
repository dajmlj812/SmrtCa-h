-- Migration 019: Phase 9 — RBAC overhaul.
--
-- Replaces the flat owner/admin/member/viewer model with two ORTHOGONAL
-- concepts:
--
--   • system-level: users.is_super_admin (boolean). A super_admin is
--     a platform operator. They manage tenants, invite tenant admins,
--     and view system health + audit logs. They CANNOT see any tenant's
--     financial data and MUST NOT carry a memberships row. The rule is
--     enforced by a CHECK + a trigger; tests assert it.
--
--   • tenant-level: memberships.role with the new set
--     {admin, spouse, child}. Existing rows are rewritten:
--         owner  -> admin
--         admin  -> admin
--         member -> spouse
--         viewer -> child
--
-- New tables:
--
--   • `account_user_access` — per-account ACL used by 'child' role.
--     Admins/spouses see everything; children see only the accounts
--     they appear in here.
--
--   • `audit_log` — append-only record of who did what. Super-admin
--     console reads from this. Writers (route handlers) insert with a
--     consistent shape: actor + action + target + jsonb details.

-- ── 1. users.is_super_admin ────────────────────────────────
ALTER TABLE users
  ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false;
CREATE INDEX users_super_admin_idx ON users (id) WHERE is_super_admin = true;

-- ── 2. memberships.role rewrite ────────────────────────────
-- The existing CHECK constraint forbids the new values, so drop +
-- rewrite + re-add in the right order.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
UPDATE memberships SET role = 'admin'  WHERE role = 'owner';
UPDATE memberships SET role = 'spouse' WHERE role = 'member';
UPDATE memberships SET role = 'child'  WHERE role = 'viewer';
ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check
    CHECK (role IN ('admin','spouse','child'));

-- Likewise on invitations.role — but here `owner` was never allowed and
-- the new set is admin/spouse/child.
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
UPDATE invitations SET role = 'spouse' WHERE role = 'member';
UPDATE invitations SET role = 'child'  WHERE role = 'viewer';
ALTER TABLE invitations
  ADD CONSTRAINT invitations_role_check
    CHECK (role IN ('admin','spouse','child'));

-- ── 3. Enforce "super admin has no memberships" ────────────
-- A trigger checks both directions: inserting a membership for a
-- super-admin user fails, and flipping is_super_admin=true on a user
-- who already has memberships fails.
CREATE OR REPLACE FUNCTION enforce_super_admin_no_memberships()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'memberships' THEN
    IF EXISTS (
      SELECT 1 FROM users WHERE id = NEW.user_id AND is_super_admin = true
    ) THEN
      RAISE EXCEPTION
        'super_admin users cannot have tenant memberships (user_id=%)',
        NEW.user_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'users' THEN
    IF NEW.is_super_admin = true
       AND EXISTS (SELECT 1 FROM memberships WHERE user_id = NEW.id) THEN
      RAISE EXCEPTION
        'cannot promote user to super_admin while they have memberships (user_id=%)',
        NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memberships_block_super_admin ON memberships;
CREATE TRIGGER memberships_block_super_admin
  BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION enforce_super_admin_no_memberships();

DROP TRIGGER IF EXISTS users_block_promote_if_member ON users;
CREATE TRIGGER users_block_promote_if_member
  BEFORE UPDATE OF is_super_admin ON users
  FOR EACH ROW EXECUTE FUNCTION enforce_super_admin_no_memberships();

-- ── 4. account_user_access (child ACL) ─────────────────────
CREATE TABLE account_user_access (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_user_access_user_idx ON account_user_access (user_id, tenant_id);

-- ── 5. audit_log ───────────────────────────────────────────
CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Wall-clock event time. timestamptz so cross-zone replicas line up.
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- NULL when the event is system-level (e.g. tenant.create by a super
  -- admin). Otherwise the tenant the event belongs to.
  tenant_id     uuid REFERENCES tenants(id) ON DELETE SET NULL,
  -- NULL when the actor is the system itself (e.g. a backup scheduler
  -- tick). Otherwise the user that performed the action.
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- 'super_admin' | 'tenant_user' | 'system' | 'public' — denormalized
  -- to make filter queries cheap.
  actor_kind    text NOT NULL CHECK (actor_kind IN
    ('super_admin','tenant_user','system','public')),
  -- Dotted-namespace action key. e.g. 'tenant.create', 'member.add',
  -- 'member.role_change', 'invite.create', 'invite.accept',
  -- 'auth_provider.update', 'settings.update', 'account.access_grant',
  -- 'super_admin.login', 'super_admin.tenant_disable'.
  action        text NOT NULL,
  -- Free-form target type, e.g. 'tenant', 'membership', 'user',
  -- 'auth_provider_config', 'invitation'. Optional.
  target_kind   text,
  -- Foreign id of the target, as text so it can carry uuids OR slugs.
  target_id     text,
  -- Per-action context payload. Keep PII out — store ids, names, and
  -- before/after values for fields that changed, not raw secrets.
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_tenant_idx     ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_occurred_idx   ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_action_idx     ON audit_log (action, occurred_at DESC);
