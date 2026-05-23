-- Migration 007: Phase 6.1 — AI-assisted recurring detection + flexible
-- budget periods. Completes the deferral noted in the 0.6.0 changelog.
--
-- Two changes:
--
-- 1. recurring_suggestions — output of the detection pass. Each row is one
--    pattern the detector found (a likely-recurring bill or income). The
--    user reviews and either Confirms (which creates a bills /
--    recurring_income row), Rejects (mark as not-recurring), or Snoozes
--    (skip for now, re-surface next run).
--
-- 2. budgets gains `period_type` and `period_end`. period_type is the
--    cadence ('weekly' / 'biweekly' / 'semimonthly' / 'monthly' /
--    'custom'); period_end is only stored for 'custom' since the other
--    types compute their end from the start + a fixed length. Existing
--    rows backfill as 'monthly'. The unique index over (month, category)
--    is dropped — multiple budgets per category at different cadences are
--    now permitted (e.g. a $50 weekly grocery budget alongside a $200
--    monthly utilities budget under the same category).

CREATE TABLE recurring_suggestions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('bill','income')),
  name              text NOT NULL,
  -- Normalized merchant or description prefix; used to de-dupe re-runs.
  normalized_key    text NOT NULL,
  amount_cents      bigint NOT NULL,
  detected_frequency text NOT NULL
    CHECK (detected_frequency IN ('weekly','biweekly','semimonthly','monthly','yearly','one-time','unknown')),
  -- The transactions that the detector grouped together (last 5 max).
  sample_txn_ids    uuid[] NOT NULL,
  confidence        numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status            text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','rejected','snoozed')),
  -- bills.id or recurring_income.id depending on `kind`. Set when status='confirmed'.
  resolved_to_id    uuid,
  ai_refined        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);
-- A given (kind, normalized_key) appears at most once in non-rejected state.
-- Rejected entries are kept so the detector doesn't re-surface them.
CREATE UNIQUE INDEX recurring_suggestions_active_unique
  ON recurring_suggestions (kind, lower(normalized_key))
  WHERE status IN ('pending','confirmed','snoozed');
CREATE INDEX recurring_suggestions_status_idx
  ON recurring_suggestions (status, created_at DESC);

-- Budget period flexibility.
DROP INDEX IF EXISTS budgets_unique;

ALTER TABLE budgets
  ADD COLUMN period_type text NOT NULL DEFAULT 'monthly'
    CHECK (period_type IN ('weekly','biweekly','semimonthly','monthly','custom')),
  ADD COLUMN period_end date;

-- For 'custom' rows, period_end MUST be set and after period_month.
ALTER TABLE budgets
  ADD CONSTRAINT budgets_custom_has_end
    CHECK (period_type <> 'custom' OR (period_end IS NOT NULL AND period_end > period_month));

CREATE INDEX budgets_period_type_start_idx
  ON budgets (period_type, period_month);
