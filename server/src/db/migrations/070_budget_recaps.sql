-- Migration 070 (0.21.x): monthly budget recaps.
--
-- Persists an AI-narrated review of a closed budget month so we
-- can render it on demand (and so the API doesn't burn Claude
-- tokens regenerating an existing report). One row per
-- (tenant_id, recap_month) — recap_month is the first of the
-- month covered by the report.

CREATE TABLE budget_recaps (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recap_month     DATE         NOT NULL,
  -- Headline numbers (computed at recap time, frozen for the row).
  budgeted_cents  BIGINT       NOT NULL,
  actual_cents    BIGINT       NOT NULL,
  hit_count       INTEGER      NOT NULL,
  under_count     INTEGER      NOT NULL,
  over_count      INTEGER      NOT NULL,
  -- Structured per-category breakdown (JSON array).
  buckets         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- AI-generated narrative paragraphs (markdown).
  narrative       TEXT         NOT NULL,
  generated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, recap_month)
);

CREATE INDEX budget_recaps_tenant_month_idx
  ON budget_recaps (tenant_id, recap_month DESC);

COMMENT ON TABLE budget_recaps IS
  '0.21.x — month-end budget recaps with AI-narrated feedback. Generated on demand (manual button) or by the daily scheduler; one row per tenant per month.';

-- Extend insight_cards.kind so the recap can post a dashboard
-- card linking back to the recap page.
ALTER TABLE insight_cards
  DROP CONSTRAINT IF EXISTS insight_cards_kind_check;

ALTER TABLE insight_cards
  ADD CONSTRAINT insight_cards_kind_check CHECK (kind IN (
    'anomaly',
    'budget_overrun_trend',
    'goal_pace_slipping',
    'unusual_recurring_charge',
    'cash_flow_warning',
    'fee_drag',
    'warranty_expiring',
    'budget_recap'
  ));
