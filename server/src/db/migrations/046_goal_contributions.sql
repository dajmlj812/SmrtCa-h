-- Migration 046 (0.18.5): goal contribution history.
--
-- Each row is one deposit toward a savings_goal. The goal's
-- current_amount_cents continues to be the ground-truth balance —
-- the contributions table is an *audit trail* that lets the UI show
-- "you put $X in on date Y" without backfilling from somewhere else.
--
-- Linking to a specific transaction is intentionally optional. The
-- common flow ("I'm setting aside $50 from this paycheck") doesn't
-- have a matching transaction row, and forcing one would block the
-- feature on a UI that doesn't exist yet. v0.18.5 surfaces only the
-- manual contribute action; transaction-tagging is a follow-up.

CREATE TABLE goal_contributions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  goal_id       uuid NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0),
  note          text,
  contributed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX goal_contributions_goal_id_idx
  ON goal_contributions (goal_id, contributed_at DESC);
CREATE INDEX goal_contributions_tenant_id_idx
  ON goal_contributions (tenant_id);

COMMENT ON TABLE goal_contributions IS
  '0.18.5 — audit trail of deposits/withdrawals against a savings_goal. amount_cents is signed (positive = contribution, negative = withdrawal/correction). savings_goals.current_amount_cents remains the ground truth.';
