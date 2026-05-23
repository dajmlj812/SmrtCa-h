-- Migration 014: Phase 7.3 — commute routes + Misc/Savings categories.
--
-- Folds the old `toll_routes` table into a richer `commute_routes` model
-- that also drives fuel math. Each route has a distance, an optional
-- per-crossing toll, and N vehicle assignments saying how many times
-- per week each vehicle crosses it. The budget wizard then computes:
--
--   per-vehicle weekly miles = SUM(route.distance × this vehicle's crossings)
--   route weekly tolls       = route.toll_per_crossing × SUM(crossings across all vehicles)
--
-- Vehicles with no assignments fall back to their stored
-- `weekly_avg_miles` so nothing forces a migration of perfectly-fine
-- vehicle data.

CREATE TABLE commute_routes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  distance_miles          numeric(10, 2) NOT NULL DEFAULT 0
    CHECK (distance_miles >= 0),
  toll_per_crossing_cents integer
    CHECK (toll_per_crossing_cents IS NULL OR toll_per_crossing_cents >= 0),
  active                  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commute_routes_active_idx ON commute_routes (active);

CREATE TABLE route_vehicle_assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id            uuid NOT NULL REFERENCES commute_routes(id) ON DELETE CASCADE,
  vehicle_id          uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  crossings_per_week  numeric(8, 2) NOT NULL DEFAULT 0
    CHECK (crossings_per_week >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, vehicle_id)
);
CREATE INDEX route_vehicle_assignments_route_idx ON route_vehicle_assignments (route_id);
CREATE INDEX route_vehicle_assignments_vehicle_idx ON route_vehicle_assignments (vehicle_id);

-- Migrate every existing toll_routes row into commute_routes. The legacy
-- weekly_estimate_cents is interpreted as a per-crossing toll on a route
-- with distance=0 and no vehicle assignments — so it still contributes a
-- weekly toll figure when the user adds at least one assignment later
-- (until then it contributes $0). The user is expected to revisit each
-- migrated route to set the real distance + crossings.
INSERT INTO commute_routes (id, name, distance_miles, toll_per_crossing_cents, active, created_at)
SELECT id, name, 0, weekly_estimate_cents, active, created_at
  FROM toll_routes;

DROP TABLE toll_routes;

-- Misc editable + per-period memo on every budget row (only really used
-- by Misc, but we store it generically).
ALTER TABLE budgets
  ADD COLUMN note text;

-- Two leaf categories the wizard needs. Wrapped in a DO block so the
-- migration is safe to re-run on databases that already have them.
DO $$
DECLARE
  misc_id  uuid;
  save_id  uuid;
BEGIN
  SELECT id INTO misc_id FROM categories WHERE lower(name) = 'miscellaneous' LIMIT 1;
  IF misc_id IS NULL THEN
    INSERT INTO categories (name) VALUES ('Miscellaneous');
  END IF;

  SELECT id INTO save_id FROM categories WHERE lower(name) = 'savings' LIMIT 1;
  IF save_id IS NULL THEN
    INSERT INTO categories (name) VALUES ('Savings');
  END IF;
END $$;
