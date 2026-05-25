-- Migration 039 (0.17.19): re-do migration 038's backfill but
-- join tenant via accounts.tenant_id, not transactions.tenant_id.
--
-- 038 used `JOIN transactions t ON t.tenant_id = b.tenant_id`
-- which silently returned zero rows on the test box because
-- `transactions.tenant_id` is unpopulated there — only the
-- joined `accounts.tenant_id` carries the value. Every other
-- read path in the codebase already joins through accounts;
-- 038 was the outlier.

WITH bill_matches AS (
  SELECT b.id AS bill_id,
         t.account_id,
         COUNT(*) AS hits,
         ROW_NUMBER() OVER (
           PARTITION BY b.id
           ORDER BY COUNT(*) DESC, t.account_id
         ) AS rn
    FROM bills b
    JOIN accounts     a ON a.tenant_id = b.tenant_id
    JOIN transactions t ON t.account_id = a.id
   WHERE b.account_id IS NULL
     AND t.amount_cents < 0
     AND (
       lower(t.raw_description)      LIKE '%' || lower(b.name) || '%'
       OR lower(t.normalized_merchant) LIKE '%' || lower(b.name) || '%'
     )
   GROUP BY b.id, t.account_id
)
UPDATE bills b
   SET account_id = m.account_id
  FROM bill_matches m
 WHERE m.bill_id = b.id
   AND m.rn = 1;

WITH income_matches AS (
  SELECT ri.id AS income_id,
         t.account_id,
         COUNT(*) AS hits,
         ROW_NUMBER() OVER (
           PARTITION BY ri.id
           ORDER BY COUNT(*) DESC, t.account_id
         ) AS rn
    FROM recurring_income ri
    JOIN accounts     a ON a.tenant_id = ri.tenant_id
    JOIN transactions t ON t.account_id = a.id
   WHERE ri.account_id IS NULL
     AND t.amount_cents > 0
     AND (
       lower(t.raw_description)      LIKE '%' || lower(ri.name) || '%'
       OR lower(t.normalized_merchant) LIKE '%' || lower(ri.name) || '%'
     )
   GROUP BY ri.id, t.account_id
)
UPDATE recurring_income ri
   SET account_id = m.account_id
  FROM income_matches m
 WHERE m.income_id = ri.id
   AND m.rn = 1;
