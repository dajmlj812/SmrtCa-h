-- Migration 059 (0.19.2): cleared/uncleared reconciliation.
--
-- Banktivity / Moneydance / Quicken users expect a per-transaction
-- "cleared" flag they tick when the bank's statement confirms the
-- charge. The flag lets a reconcile workflow tell the user
-- "your books match the statement" once every uncleared row in the
-- statement period has been ticked through.
--
-- Storing the date when the transaction CLEARED (rather than a
-- boolean) gives us free "as-of cleared balance" queries — sum
-- amount_cents where cleared_at <= asOf. Cheaper than maintaining
-- a denormalized running balance column.

ALTER TABLE transactions
  ADD COLUMN cleared_at TIMESTAMPTZ NULL;

-- Speeds up: "uncleared transactions in this account" (the
-- reconcile workflow's primary view) and "cleared balance as of
-- date X". Partial index on cleared_at IS NULL is half the size
-- of a full one; the cleared-balance query uses the regular
-- (account_id, txn_date) index that already exists.
CREATE INDEX idx_transactions_account_uncleared
  ON transactions (account_id, txn_date)
  WHERE cleared_at IS NULL;

COMMENT ON COLUMN transactions.cleared_at IS
  '0.19.2 — date the bank statement confirmed this transaction. NULL = uncleared (still pending reconcile). Used by the Reconcile workflow + the as-of cleared balance API.';
