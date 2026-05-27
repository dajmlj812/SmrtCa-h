-- Migration 063 (0.21.0): IRS-compliant mileage log.
--
-- The existing commute_routes table tracks recurring routes for
-- budget projection ("X crossings per week"), which is great for
-- forecasting but isn't an IRS-acceptable substitute for an
-- actual contemporaneous mileage log. For Schedule C / Form 2106
-- the user needs date-stamped trip entries with purpose, mileage,
-- and (recommended) start/end locations.
--
-- One row per trip. `purpose` follows the IRS standard-mileage
-- categories — different categories have different per-mile
-- deduction rates and roll up to different lines on the return.

CREATE TABLE mileage_log (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id      UUID         NULL REFERENCES vehicles(id) ON DELETE SET NULL,
  trip_date       DATE         NOT NULL,
  purpose         TEXT         NOT NULL,
  miles           NUMERIC(10,2) NOT NULL CHECK (miles >= 0),
  start_odometer  NUMERIC(10,1) NULL,
  end_odometer    NUMERIC(10,1) NULL,
  start_location  TEXT         NULL,
  end_location    TEXT         NULL,
  description     TEXT         NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT mileage_log_purpose_check CHECK (purpose IN (
    'business', 'commute', 'charity', 'medical', 'moving', 'personal'
  )),
  CONSTRAINT mileage_log_odometer_order CHECK (
    start_odometer IS NULL OR end_odometer IS NULL
    OR end_odometer >= start_odometer
  )
);

-- Year-end report scans by tenant + date range; everything else
-- (per-vehicle drill-down, recent trips list) piggy-backs on this.
CREATE INDEX mileage_log_tenant_date_idx
  ON mileage_log (tenant_id, trip_date DESC);

CREATE INDEX mileage_log_tenant_vehicle_idx
  ON mileage_log (tenant_id, vehicle_id)
  WHERE vehicle_id IS NOT NULL;

COMMENT ON TABLE mileage_log IS
  '0.21.0 — IRS-compliant per-trip mileage log. Powers the Schedule C / mileage section of the tax export.';
COMMENT ON COLUMN mileage_log.purpose IS
  'business | commute | charity | medical | moving | personal — drives which standard-mileage rate applies and where it lands on the return.';
