-- Migration 029 (backlog 0.13.6): non-AI rules engine completion.
--
-- Three additions to `normalization_rules`:
--
--   1. `tenant_id` — rules are now per-tenant. The original Phase-6.2
--      table predated multi-tenant; rows existed globally and the
--      apply route had no scope. Existing rows are backfilled to the
--      Default tenant (the only tenant on every solo install). On a
--      multi-tenant install where a non-default tenant created rules
--      before this migration, those rules would have been visible to
--      every tenant anyway — backfilling them to Default is no worse,
--      and an operator can re-tag them with a manual UPDATE if needed.
--
--   2. `enabled` — boolean toggle so a noisy rule can be paused
--      without deletion. The auto-apply pass (in persistBatch) and
--      the on-demand apply route both honor this.
--
--   3. `priority` — int ordering. When multiple rules match the same
--      transaction, higher priority wins. The apply loop iterates
--      ASC so high-priority rules write LAST and their values
--      overwrite. Default 0 leaves all existing rules tied (which
--      preserves today's "whichever-the-planner-returned-last wins"
--      behavior on tied rules).
--
-- Also rebuilds the case-insensitive pattern uniqueness as a
-- (tenant_id, lower(pattern)) composite so two tenants can each have
-- their own "ONSTAR" rule without colliding.

ALTER TABLE normalization_rules
  ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  ADD COLUMN enabled   boolean NOT NULL DEFAULT true,
  ADD COLUMN priority  int     NOT NULL DEFAULT 0;

-- Backfill existing rows to the Default tenant if one exists. On a
-- brand-new install with no tenants seeded yet, the WHERE clause is
-- a no-op and the NOT NULL below is still applied to an empty table.
UPDATE normalization_rules
   SET tenant_id = (SELECT id FROM tenants WHERE slug = 'default' LIMIT 1)
 WHERE tenant_id IS NULL;

-- If any rule still has NULL tenant_id at this point (no Default
-- tenant existed), drop it — a rule with no tenant has no scope under
-- the new model and would be invisible to every route.
DELETE FROM normalization_rules WHERE tenant_id IS NULL;

ALTER TABLE normalization_rules
  ALTER COLUMN tenant_id SET NOT NULL;

-- Replace the old global unique index with a per-tenant one.
DROP INDEX IF EXISTS normalization_rules_pattern_unique;
CREATE UNIQUE INDEX normalization_rules_pattern_unique
  ON normalization_rules (tenant_id, lower(pattern));

-- Hot path: the import-time auto-apply loads enabled rules for one
-- tenant on every import. Keeps the planner honest as rule counts
-- grow.
CREATE INDEX normalization_rules_active_idx
  ON normalization_rules (tenant_id, priority)
  WHERE enabled = true;
