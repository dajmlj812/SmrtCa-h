-- 0.18.13 — schedule future changes to bills + recurring income.
--
-- Real-world recurring items don't stay constant: rent goes up at
-- the next lease renewal, the phone bill drops when the promo ends,
-- the paycheck bumps after a raise. Operators currently have to
-- either edit the bill (losing history of the prior amount) or
-- create a separate item (which double-counts during the transition).
--
-- This table records future-effective changes that the projection
-- engine consults at read time. The parent row stays unchanged
-- until the change's effective_date passes — at that point the
-- application code "promotes" the change: updates the parent
-- bill/income row and marks the change row applied.
--
-- One table covers both bills and recurring_income via a
-- polymorphic-but-checked target. The CHECK constraint ensures
-- exactly one of the two FK columns is non-NULL on every row.

CREATE TABLE IF NOT EXISTS recurring_schedule_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Exactly one of these is set per row (CHECK constraint below).
  bill_id         uuid REFERENCES bills(id) ON DELETE CASCADE,
  income_id       uuid REFERENCES recurring_income(id) ON DELETE CASCADE,
  -- The date on which the parent row should reflect the new values.
  effective_date  date NOT NULL,
  -- New values. NULL = leave the parent field unchanged.
  new_amount_cents bigint CHECK (new_amount_cents IS NULL OR new_amount_cents > 0),
  new_frequency   text CHECK (
    new_frequency IS NULL OR
    new_frequency = ANY (ARRAY['monthly','weekly','biweekly','yearly','one-time'])
  ),
  -- Optional explanation for the operator's own reference.
  note            text,
  -- Set when the change has been folded into the parent row.
  -- Provides forensic history: "we know that on date X, this bill
  -- went from $A to $B."
  applied_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT recurring_schedule_changes_one_target CHECK (
    (bill_id IS NOT NULL AND income_id IS NULL) OR
    (bill_id IS NULL AND income_id IS NOT NULL)
  ),
  -- At least one of the "new_*" columns must be populated; a row
  -- with no changes is meaningless.
  CONSTRAINT recurring_schedule_changes_has_change CHECK (
    new_amount_cents IS NOT NULL OR new_frequency IS NOT NULL
  )
);

-- Lookup pattern: "give me upcoming changes for this bill/income,
-- in effective_date order".
CREATE INDEX IF NOT EXISTS recurring_schedule_changes_bill_idx
  ON recurring_schedule_changes (bill_id, effective_date)
  WHERE bill_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS recurring_schedule_changes_income_idx
  ON recurring_schedule_changes (income_id, effective_date)
  WHERE income_id IS NOT NULL;

-- Sweep pattern: "find every unapplied change whose effective_date
-- has passed". The application code runs this on a schedule + on
-- the next read of any bill/income with pending changes.
CREATE INDEX IF NOT EXISTS recurring_schedule_changes_ready_idx
  ON recurring_schedule_changes (effective_date)
  WHERE applied_at IS NULL;

COMMENT ON TABLE recurring_schedule_changes IS
  'Future-effective changes to bills + recurring_income. Promoted to the parent row on or after effective_date.';
