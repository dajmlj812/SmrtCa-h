-- Migration 012: Phase 7.1 — vehicles, toll routes, fuel prices, bill-linked
-- budgets. Powers the AutoMagic budget wizard and the per-vehicle fuel
-- calculator.
--
-- Four schema changes:
--
-- 1. vehicles — per-vehicle inputs to the fuel calculator. ICE
--    vehicles use mpg + fuel_type; electric vehicles use
--    kwh_per_mile + electricity_rate_cents_per_kwh. weekly_avg_miles
--    is what the calculator multiplies against. A CHECK ensures the
--    appropriate fields are populated per fuel_type.
--
-- 2. toll_routes — named recurring toll outlays. Each has a weekly $
--    estimate; the wizard sums active routes scaled to the budget
--    period length.
--
-- 3. fuel_prices — current $/gallon by grade. source='eia' rows are
--    refreshed from api.eia.gov when an EIA_API_KEY is set;
--    source='manual' rows are user-set overrides that win when
--    present. One row per fuel_type at most (enforced by PK on
--    fuel_type, NOT by composite key — overrides replace the cached
--    value in place).
--
-- 4. budgets.bill_id — links a budget row to the specific bill it
--    represents. When set, the row's display name and amount come
--    from the bill; the row's "actual" is the bill's marked-paid
--    state within the period (computed at query time).

CREATE TABLE vehicles (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                            text NOT NULL,
  fuel_type                       text NOT NULL
    CHECK (fuel_type IN ('regular','midgrade','premium','diesel','electric')),
  -- ICE: required when fuel_type is gasoline/diesel.
  mpg                             numeric(8, 2),
  -- EV: required when fuel_type='electric'.
  kwh_per_mile                    numeric(8, 4),
  electricity_rate_cents_per_kwh  integer,
  weekly_avg_miles                numeric(10, 2) NOT NULL CHECK (weekly_avg_miles >= 0),
  active                          boolean NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicles_fuel_shape CHECK (
    (fuel_type = 'electric' AND kwh_per_mile IS NOT NULL AND electricity_rate_cents_per_kwh IS NOT NULL)
    OR (fuel_type <> 'electric' AND mpg IS NOT NULL AND mpg > 0)
  )
);
CREATE INDEX vehicles_active_idx ON vehicles (active);

CREATE TABLE toll_routes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  weekly_estimate_cents bigint NOT NULL CHECK (weekly_estimate_cents >= 0),
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX toll_routes_active_idx ON toll_routes (active);

CREATE TABLE fuel_prices (
  fuel_type               text PRIMARY KEY
    CHECK (fuel_type IN ('regular','midgrade','premium','diesel')),
  price_cents_per_gallon  integer NOT NULL CHECK (price_cents_per_gallon >= 0),
  source                  text NOT NULL CHECK (source IN ('eia','manual')),
  fetched_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE budgets
  ADD COLUMN bill_id uuid REFERENCES bills(id) ON DELETE SET NULL;
CREATE INDEX budgets_bill_id_idx ON budgets (bill_id) WHERE bill_id IS NOT NULL;
