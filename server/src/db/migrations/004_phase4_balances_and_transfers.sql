-- Migration 004: Phase 4 — opening balances + transfer linking support.
--
-- Two changes:
--
-- 1. accounts.opening_balance_cents + opening_balance_date — closes KI-01.
--    The account's true balance is opening + sum of transactions on or after
--    the opening date. Existing accounts default to 0 / null, which is
--    equivalent to the old "net of imported activity" behavior — so nothing
--    breaks on upgrade. The user fills these in per account in the UI.
--
-- 2. Partial index on transactions.transfer_group_id — needed by transfer
--    detection (find unpaired candidates) and by the transfers list page
--    (find all paired rows efficiently). The column itself was added in
--    migration 001; only the index is new here.

ALTER TABLE accounts
  ADD COLUMN opening_balance_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN opening_balance_date  date;

CREATE INDEX transactions_transfer_group_idx
  ON transactions (transfer_group_id)
  WHERE transfer_group_id IS NOT NULL;
