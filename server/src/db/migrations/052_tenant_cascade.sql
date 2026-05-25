-- F-34 (security audit 2026-05-25) — tenant_id FKs to ON DELETE CASCADE.
--
-- Before this migration, 18 of the tenant_id foreign keys on data
-- tables defaulted to NO ACTION, which is RESTRICT semantics in
-- Postgres: any attempt to DELETE FROM tenants for a tenant that
-- had ever stored data would throw a foreign-key violation. That
-- made the super-admin "delete tenant" route effectively broken
-- AND blocked the new user-self-deletion endpoint (F-35) from
-- working for any real customer.
--
-- The right policy is CASCADE: tenant deletion should take every
-- tenant-scoped data row with it. Memberships, plaid_items,
-- ofx_dc_connections etc. already had CASCADE; we're bringing the
-- other 18 into line. Attachment FILES on disk are still cleaned up
-- by the application code in the delete-user endpoint — the SQL
-- cascade only handles DB rows.
--
-- audit_log keeps ON DELETE SET NULL so the audit trail of a
-- deleted tenant remains in place for super-admin forensic review.
-- sessions.active_tenant_id keeps ON DELETE SET NULL so a session
-- pointing at a deleted tenant just loses its tenant context (the
-- requireTenant gate then 403s the user) instead of vaporizing.

DO $$
DECLARE
  fk RECORD;
  -- Tables whose tenant_id FK we want to cascade. Listed explicitly
  -- so a typo here is louder than a "for-every-FK" loop would be.
  cascade_tables text[] := ARRAY[
    'accounts',
    'attachments',
    'bills',
    'budgets',
    'categories',
    'category_suggestions',
    'commute_routes',
    'fuel_prices',
    'holdings',
    'import_batches',
    'normalization_rules',
    'recurring_income',
    'recurring_suggestions',
    'route_vehicle_assignments',
    'savings_goals',
    'transaction_splits',
    'transactions',
    'vehicles'
  ];
  t text;
  constraint_name text;
BEGIN
  FOREACH t IN ARRAY cascade_tables LOOP
    -- Find the existing FK from <t>.tenant_id -> tenants.id.
    SELECT con.conname INTO constraint_name
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
     WHERE cls.relname = t
       AND con.contype = 'f'
       AND con.confrelid = 'tenants'::regclass;
    IF constraint_name IS NULL THEN
      RAISE NOTICE 'No tenants FK found on table %, skipping', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, constraint_name);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE',
      t,
      constraint_name
    );
  END LOOP;
END $$;

-- Verify the result. This SELECT runs at migration time and produces a
-- NOTICE listing the new cascade state, useful when reading
-- post-migrate logs.
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT COUNT(*) INTO remaining
    FROM pg_constraint
   WHERE confrelid = 'tenants'::regclass
     AND contype = 'f'
     AND confdeltype IN ('a','r');
  IF remaining > 0 THEN
    RAISE NOTICE
      'After migration 052, % FK(s) to tenants still default to NO ACTION/RESTRICT — review for completeness.',
      remaining;
  ELSE
    RAISE NOTICE 'All tenant_id FKs now CASCADE or SET NULL. F-34 resolved.';
  END IF;
END $$;
