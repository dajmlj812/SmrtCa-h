-- Migration 034 (0.17.6): budgets.tenant_id NOT NULL + backfill orphans.
--
-- Two bugs in the budget-wizard flow (commitWizard + buildWizardPreview)
-- predated the 0.14.x multi-tenant isolation pass and were never wired
-- up to set tenant_id on INSERT. Any operator who used AutoMagic
-- created rows with NULL tenant_id; those rows are invisible to the
-- /budgets page (which filters WHERE tenant_id = $1) — effectively
-- orphaned in the database.
--
-- This migration:
--   1. Backfills NULL tenant_id rows when the deployment has exactly
--      one tenant. Single-tenant deploys are the safe automatic case
--      because there's only one valid destination. Multi-tenant
--      deploys with orphans are ambiguous — we'd be guessing which
--      tenant the wizard ran for — so we DELETE the orphans instead.
--      Either way, the routes are already fixed (0.17.6) so new
--      runs always set tenant_id.
--   2. Adds NOT NULL on the column so a future regression of the
--      same bug fails the INSERT instead of silently creating
--      orphans.

DO $$
DECLARE
  tenant_count int;
  default_tenant uuid;
BEGIN
  SELECT COUNT(*) INTO tenant_count FROM tenants;

  IF tenant_count = 1 THEN
    -- Single-tenant deploy: backfill all orphans to that tenant.
    SELECT id INTO default_tenant FROM tenants;
    UPDATE budgets SET tenant_id = default_tenant WHERE tenant_id IS NULL;
    RAISE NOTICE 'budgets: backfilled NULL tenant_id rows to single tenant %', default_tenant;
  ELSIF tenant_count > 1 THEN
    -- Multi-tenant deploy: orphans are ambiguous, delete them.
    -- They were never visible from any tenant's /budgets page so no
    -- in-app behavior changes.
    DELETE FROM budgets WHERE tenant_id IS NULL;
    RAISE NOTICE 'budgets: deleted NULL tenant_id orphans (multi-tenant deploy; ambiguous owner)';
  END IF;
END $$;

ALTER TABLE budgets ALTER COLUMN tenant_id SET NOT NULL;
