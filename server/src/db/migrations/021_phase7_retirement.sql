-- Migration 021: Phase 7.2 — retirement / long-term goal projections.
--
-- One row per projection. The math runs server-side from the
-- starting balance + monthly contribution + annual return + optional
-- inflation deflator. Starting balance is captured AT TIME OF
-- CREATION rather than recomputed each request — that's a deliberate
-- decision: a "projection" is a what-if model the user wants to
-- compare against reality, not a live rolling forecast.
--
-- Future revisions of the model can store a series of contribution
-- changes; for the first cut, a single monthly contribution is
-- sufficient. The Wizard can also write a "target_amount" so the
-- chart can render a horizontal target line.

CREATE TABLE retirement_projections (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  name                        text NOT NULL,
  -- Captured at creation. Editing recomputes via PATCH.
  starting_balance_cents      bigint NOT NULL,
  monthly_contribution_cents  bigint NOT NULL CHECK (monthly_contribution_cents >= 0),
  -- Whole-number percentages stored as numeric for clean math (5.25 -> 5.25%).
  annual_return_pct           numeric(6, 3) NOT NULL CHECK (annual_return_pct >= -100 AND annual_return_pct <= 100),
  annual_inflation_pct        numeric(6, 3) NOT NULL DEFAULT 0
    CHECK (annual_inflation_pct >= 0 AND annual_inflation_pct <= 100),
  -- Optional target — when set, the chart shows a horizontal line.
  target_year                 integer CHECK (target_year IS NULL OR (target_year >= 1900 AND target_year <= 2200)),
  target_amount_cents         bigint CHECK (target_amount_cents IS NULL OR target_amount_cents > 0),
  -- How many years to plot. Cap at 60 — the user can adjust.
  horizon_years               integer NOT NULL DEFAULT 30
    CHECK (horizon_years > 0 AND horizon_years <= 100),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retirement_projections_tenant_idx ON retirement_projections (tenant_id);
