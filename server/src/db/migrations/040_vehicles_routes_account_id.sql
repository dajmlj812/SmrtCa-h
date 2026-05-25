-- Migration 040 (0.17.20): account_id on vehicles + commute_routes.
--
-- Pre-fix the wizard's fuel + tolls projection ran across
-- every vehicle and route in the tenant, regardless of which
-- plan's accounts paid for them. With per-account plans
-- (0.17.16), that means the same $250/week fuel cost lands
-- on every plan's card — double-counted across budgets.
--
-- Fix: vehicles + commute_routes carry an account_id like
-- bills + recurring_income do. When the wizard runs with an
-- account filter, only items tagged to those accounts feed
-- the fuel/tolls calculation. NULL account_id rows are
-- excluded from every scoped wizard run — matching the
-- strict semantics introduced for bills in 0.17.17.
--
-- No backfill: vehicles/routes don't have transaction
-- history to learn from. Existing rows stay NULL until the
-- user tags them via /vehicles or /routes.

ALTER TABLE vehicles
  ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;

ALTER TABLE commute_routes
  ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX vehicles_account_idx
  ON vehicles(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX commute_routes_account_idx
  ON commute_routes(account_id) WHERE account_id IS NOT NULL;

COMMENT ON COLUMN vehicles.account_id IS
  '0.17.20 — account this vehicle''s fuel cost belongs to. When set, only the plan that scopes this account counts its weekly fuel in fuel budget projection.';
COMMENT ON COLUMN commute_routes.account_id IS
  '0.17.20 — account this route''s tolls belong to. Same semantics as vehicles.account_id.';
