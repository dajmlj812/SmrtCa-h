-- Migration 041 (0.17.21): account_id on savings_goals.
--
-- Pre-fix: the wizard's goalRequiredForPeriod() summed every
-- tenant-wide savings goal into the "goal-required" suggestion
-- chip — so a goal that's actually funded out of one account
-- would suggest the same contribution on every plan's card.
-- Each plan would budget the full goal contribution, totaling
-- 2x-3x the actual cost.
--
-- Fix: goals carry an account_id like bills, recurring_income,
-- vehicles, and commute_routes. When the wizard runs with an
-- account filter, only goals tagged to those accounts feed
-- the per-period goal-required suggestion. NULL account_id
-- goals are excluded from scoped wizard runs — same strict
-- semantics as the other axes.

ALTER TABLE savings_goals
  ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX savings_goals_account_idx
  ON savings_goals(account_id) WHERE account_id IS NOT NULL;

COMMENT ON COLUMN savings_goals.account_id IS
  '0.17.21 — account this goal is funded from. When set, only the plan scoping this account counts the goal in goal-required savings suggestion.';
