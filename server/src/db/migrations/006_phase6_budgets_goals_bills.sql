-- Migration 006: Phase 6 — budgeting, savings goals, bills, recurring income.
--
-- Four new tables:
--
-- 1. budgets — one row per (period_month, category). category_id IS NULL
--    represents the flex-pool budget (catches spending in categories that
--    don't have an explicit row that month).
--
-- 2. savings_goals — name + target + current + optional target_date. The
--    current_amount is adjusted manually for now; auto-funding from
--    leftover budget arrives in a later phase.
--
-- 3. bills — user-defined recurring or one-time outflows. The mark-paid
--    endpoint advances next_due_date by the bill's frequency.
--
-- 4. recurring_income — user-defined recurring inflows, used by the
--    cash-flow projection. Kept separate from bills so the cash-flow
--    math doesn't have to inspect signs everywhere.
--
-- All money columns are bigint (integer cents); all dates use the
-- timezone-safe `date` type.

CREATE TABLE budgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month date NOT NULL CHECK (extract(day from period_month) = 1),
  category_id  uuid REFERENCES categories(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- One budget per (month, category). Treat NULL category as a sentinel
-- so the flex-pool row is also unique per month.
CREATE UNIQUE INDEX budgets_unique
  ON budgets (period_month, COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX budgets_period_idx ON budgets (period_month);

CREATE TABLE savings_goals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  target_amount_cents  bigint NOT NULL CHECK (target_amount_cents > 0),
  current_amount_cents bigint NOT NULL DEFAULT 0
    CHECK (current_amount_cents >= 0),
  target_date          date,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bills (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  frequency      text NOT NULL
    CHECK (frequency IN ('monthly','weekly','biweekly','yearly','one-time')),
  next_due_date  date NOT NULL,
  category_id    uuid REFERENCES categories(id) ON DELETE SET NULL,
  account_id     uuid REFERENCES accounts(id) ON DELETE SET NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bills_active_due_idx ON bills (next_due_date) WHERE active;

CREATE TABLE recurring_income (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  frequency          text NOT NULL
    CHECK (frequency IN ('monthly','weekly','biweekly','yearly')),
  next_expected_date date NOT NULL,
  account_id         uuid REFERENCES accounts(id) ON DELETE SET NULL,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurring_income_active_idx ON recurring_income (next_expected_date) WHERE active;
