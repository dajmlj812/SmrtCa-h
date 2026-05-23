-- Migration 028 (backlog 0.13.4): per-account permission level.
--
-- Today every account_user_access row is implicitly read+write —
-- a child appears in this table to GAIN access, and once they do
-- they can edit. Add a permission column so each row can be
-- scoped to read-only (view) or read_write (edit). Default
-- 'read_write' preserves the current behavior for existing rows.
--
-- Combined with rbac generalization, this also lets a SPOUSE be
-- restricted to a subset of accounts (and per-account
-- view-vs-edit), where previously spouse was always full-tenant.

ALTER TABLE account_user_access
  ADD COLUMN permission text NOT NULL DEFAULT 'read_write'
    CHECK (permission IN ('read', 'read_write'));

-- Partial index for the "what can this user write to" lookup —
-- the dominant check inside mutation routes.
CREATE INDEX account_user_access_user_write_idx
  ON account_user_access (user_id, tenant_id)
  WHERE permission = 'read_write';
