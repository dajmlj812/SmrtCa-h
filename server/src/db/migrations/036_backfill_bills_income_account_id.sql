-- Migration 036 (0.17.14): backfill bills.account_id and
-- recurring_income.account_id from their most-frequent
-- matching transaction.
--
-- Why this is needed: the AutoMagic budget wizard scopes
-- bills + income by account (since 0.17.12), and the
-- Period Overview filter treats `account_id IS NULL` as
-- "household-wide, always include." That's the correct
-- rule for genuinely-shared items (e.g. rent paid out of a
-- pooled household account), but most existing rows were
-- created via the recurring-detection job or manual entry
-- without an account_id set. The result: an operator who
-- scopes a wizard run to "Chase 5793" still saw "CAMCO
-- Precision Payroll" income on the card because CAMCO had
-- NULL account_id and was treated as household-wide,
-- despite every CAMCO deposit actually landing in
-- Chase-Aadyn.
--
-- Fix: for each row with NULL account_id, find the
-- account that has the most matching transactions and set
-- account_id to that. Matching: first word of the bill/
-- income name appears in lower(normalized_merchant) or
-- lower(raw_description), with transaction sign matching
-- the row type (income > 0, bills < 0).
--
-- Safety: only updates rows where account_id IS NULL. If
-- the heuristic finds no match (e.g. the name has no
-- corresponding transactions yet), the row stays NULL
-- and continues to behave as "household-wide" — the
-- operator can manually edit via the UI later.

-- Backfill recurring_income: income transactions are amount_cents > 0
UPDATE recurring_income ri
   SET account_id = best.account_id
  FROM (
    SELECT DISTINCT ON (ri2.id) ri2.id AS income_id, a.id AS account_id, COUNT(*) AS match_count
      FROM recurring_income ri2
      JOIN transactions t ON
        lower(coalesce(t.normalized_merchant, t.raw_description))
          LIKE '%' || lower(split_part(ri2.name, ' ', 1)) || '%'
      JOIN accounts a ON a.id = t.account_id
     WHERE ri2.account_id IS NULL
       AND a.tenant_id = ri2.tenant_id
       AND t.amount_cents > 0
       AND length(split_part(ri2.name, ' ', 1)) >= 3   -- avoid 1-2 char false matches
     GROUP BY ri2.id, a.id
     ORDER BY ri2.id, COUNT(*) DESC
  ) AS best
 WHERE ri.id = best.income_id
   AND ri.account_id IS NULL;

-- Backfill bills: bill transactions are amount_cents < 0
UPDATE bills bl
   SET account_id = best.account_id
  FROM (
    SELECT DISTINCT ON (bl2.id) bl2.id AS bill_id, a.id AS account_id, COUNT(*) AS match_count
      FROM bills bl2
      JOIN transactions t ON
        lower(coalesce(t.normalized_merchant, t.raw_description))
          LIKE '%' || lower(split_part(bl2.name, ' ', 1)) || '%'
      JOIN accounts a ON a.id = t.account_id
     WHERE bl2.account_id IS NULL
       AND a.tenant_id = bl2.tenant_id
       AND t.amount_cents < 0
       AND length(split_part(bl2.name, ' ', 1)) >= 3
     GROUP BY bl2.id, a.id
     ORDER BY bl2.id, COUNT(*) DESC
  ) AS best
 WHERE bl.id = best.bill_id
   AND bl.account_id IS NULL;
