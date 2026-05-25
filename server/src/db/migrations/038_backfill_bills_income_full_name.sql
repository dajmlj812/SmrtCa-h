-- Migration 038 (0.17.18): better backfill for bills + recurring_income account_id.
--
-- Migration 036 used a first-word LIKE heuristic, which missed
-- bills whose first word is too short or not distinctive enough
-- ("GM Financial", "We Energies", etc.). Result on the test
-- box: GM Financial + We Energies stayed NULL even though
-- there are 9 + 8 matching transactions on Chase-5793.
--
-- This migration tries again with FULL-NAME matching against
-- both `raw_description` and `normalized_merchant`. For each
-- bill/income source with NULL account_id, pick the
-- transaction account it matches most often (after tenant
-- scoping via the account join). Bills with zero matches stay
-- NULL — there's nothing to learn from.
--
-- Idempotent + safe to re-run.

WITH bill_matches AS (
  SELECT b.id AS bill_id,
         t.account_id,
         COUNT(*) AS hits,
         ROW_NUMBER() OVER (
           PARTITION BY b.id
           ORDER BY COUNT(*) DESC, t.account_id
         ) AS rn
    FROM bills b
    JOIN transactions t ON t.tenant_id = b.tenant_id
    JOIN accounts     a ON a.id = t.account_id
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
    JOIN transactions t ON t.tenant_id = ri.tenant_id
    JOIN accounts     a ON a.id = t.account_id
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
