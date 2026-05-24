-- Migration 035 (0.17.11): per-budget account scope.
--
-- When AutoMagic runs with an account filter (0.17.8) the suggested
-- amounts only consider the selected accounts. But the resulting
-- budget rows had no record of that scope, so any later actuals
-- calculation against those rows still summed transactions from
-- EVERY account in the tenant — including ones the user excluded.
--
-- Concrete symptom: "Groceries budgeted $200/week against my personal
-- checking" gets compared to "$350 spent on groceries across personal
-- AND business accounts." Off-by-an-account, every time.
--
-- Fix: each budget row remembers the account_ids the wizard
-- (or future per-row UI) intended it to cover. NULL means "every
-- account" — both the rule for pre-existing rows and the default
-- when the user wanted no scope (legacy behavior). Routes that
-- compute actuals filter `transactions.account_id` against the
-- list when it's set.

ALTER TABLE budgets
  ADD COLUMN included_account_ids uuid[];

COMMENT ON COLUMN budgets.included_account_ids IS
  '0.17.11 — when set, actuals against this budget only count transactions from these accounts. NULL = include every account in the tenant (legacy behavior).';
