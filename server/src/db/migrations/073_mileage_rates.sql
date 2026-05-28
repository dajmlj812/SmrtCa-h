-- Migration 073 (0.24.5): per-tenant mileage rates table.
--
-- The IRS publishes standard mileage rates each December (IR Notice
-- xxxx-NN) for the following tax year — business, charity, medical.
-- Until this migration they lived hardcoded in
-- server/src/routes/mileage.ts (MILEAGE_RATES), which meant adding
-- a new tax year required a code change and a deploy.
--
-- This table moves the rates into per-tenant storage so:
--   • The user can edit a year's rates from /mileage without a deploy.
--   • Each tenant can override if their tax situation needs different
--     numbers (multi-state filings sometimes do).
--   • Future "fetch from IRS" automation has a clear write target.
--
-- Defaults are seeded for every existing tenant from the same values
-- the old MILEAGE_RATES constant carried. New tenants get them via a
-- seedDefaultMileageRates() helper called from tenant creation
-- (added in a separate code change).

CREATE TABLE mileage_rates (
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tax_year               integer NOT NULL CHECK (tax_year >= 1990 AND tax_year <= 2100),
  -- Stored as cents-per-mile to stay in integer cents like the rest
  -- of the codebase. 67.0 ¢/mile → 6700 (millicents). NUMERIC(7,1)
  -- preserves the one-decimal-place precision the IRS publishes
  -- without invoking floating-point drift.
  business_cents_per_mile numeric(7,1) NOT NULL CHECK (business_cents_per_mile >= 0),
  charity_cents_per_mile  numeric(7,1) NOT NULL CHECK (charity_cents_per_mile >= 0),
  medical_cents_per_mile  numeric(7,1) NOT NULL CHECK (medical_cents_per_mile >= 0),
  source                  text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('seeded', 'manual', 'irs_fetch')),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tax_year)
);

COMMENT ON TABLE mileage_rates IS
  '0.24.5 — per-tenant IRS standard mileage rates by tax year. Drives the Schedule C car-and-truck deduction and the /mileage rates panel.';
COMMENT ON COLUMN mileage_rates.source IS
  'seeded = default on tenant creation; manual = user-edited; irs_fetch = future automated fetch from irs.gov.';

-- Backfill: for every existing tenant, seed the rates that were
-- hardcoded in MILEAGE_RATES at the time of the migration.
INSERT INTO mileage_rates
  (tenant_id, tax_year, business_cents_per_mile, charity_cents_per_mile, medical_cents_per_mile, source)
SELECT t.id, year, business, charity, medical, 'seeded'
  FROM tenants t
  CROSS JOIN (VALUES
    (2022, 62.5, 14.0, 22.0),
    (2023, 65.5, 14.0, 22.0),
    (2024, 67.0, 14.0, 21.0),
    (2025, 70.0, 14.0, 21.0),
    (2026, 70.0, 14.0, 21.0)
  ) AS rates(year, business, charity, medical)
  ON CONFLICT (tenant_id, tax_year) DO NOTHING;
