-- Migration 010: transaction_category_lines view.
--
-- A read-only convenience view that expands transactions into the
-- "effective per-category lines" used by insights, budget actuals, and
-- CSV exports. For transactions WITH at least one split row, the view
-- emits one row per split (carrying the split's category + amount).
-- For transactions WITHOUT splits, the view emits a single row using
-- the transaction's own category_id + amount_cents. Either way,
-- downstream aggregations group by category_id and sum amount_cents.
--
-- This is the single source of truth for "what category did this dollar
-- go to" — keeping it as a view means every query stays consistent
-- without having to repeat the UNION ALL.

CREATE OR REPLACE VIEW transaction_category_lines AS
  SELECT t.id           AS transaction_id,
         t.account_id,
         t.txn_date,
         t.transfer_group_id,
         t.normalization_status,
         s.category_id,
         s.amount_cents,
         TRUE             AS is_split
    FROM transactions t
    JOIN transaction_splits s ON s.transaction_id = t.id
UNION ALL
  SELECT t.id           AS transaction_id,
         t.account_id,
         t.txn_date,
         t.transfer_group_id,
         t.normalization_status,
         t.category_id,
         t.amount_cents,
         FALSE            AS is_split
    FROM transactions t
   WHERE NOT EXISTS (
     SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id
   );
