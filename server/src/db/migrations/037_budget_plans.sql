-- Migration 037 (0.17.16): per-account budget plans.
--
-- Pre-0.17.16 a tenant had one effective budget — the wizard
-- created a set of `budgets` rows, all sharing the same cadence
-- and `included_account_ids`. That model breaks when different
-- accounts pay on different paycheck cadences (Chase weekly,
-- Savings monthly, etc.) — the user wants one budget per
-- paycheck cycle, scoped to its own accounts.
--
-- Model: `budget_plans` (one row per cycle) ← `budgets.plan_id`.
-- The wizard creates ONE plan per run. The plan owns the
-- cadence + anchor + account_ids. Per-period rows in `budgets`
-- hang off the plan.
--
-- Invariant (app-enforced, not DB-enforced because uuid[]
-- membership across rows is awkward to constrain in SQL): each
-- account participates in at most one plan per tenant. The
-- POST /api/budget-plans route validates this before insert.
--
-- ON DELETE CASCADE on plan_id: removing a plan removes its
-- per-period budget rows (mirrors how the user thinks of it —
-- "delete the Chase budget" should also remove the per-week
-- Groceries lines under it).

CREATE TABLE budget_plans (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  period_type  text        NOT NULL CHECK (period_type IN
                 ('weekly','biweekly','semimonthly','monthly','custom')),
  anchor_date  date        NOT NULL,
  account_ids  uuid[]      NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX budget_plans_tenant_idx ON budget_plans(tenant_id);

ALTER TABLE budgets
  ADD COLUMN plan_id uuid REFERENCES budget_plans(id) ON DELETE CASCADE;

CREATE INDEX budgets_plan_idx ON budgets(plan_id) WHERE plan_id IS NOT NULL;

-- Backfill: collapse existing budget rows into one plan per
-- (tenant_id, period_type) — the natural shape of pre-0.17.16
-- data, where a tenant typically ran the wizard once. If a
-- tenant ran it multiple times with different cadences, each
-- cadence gets its own plan ("Imported budget (weekly)" /
-- "Imported budget (monthly)").
--
-- account_ids on the plan: take the first non-null
-- included_account_ids from a row in the cluster. If every row
-- in the cluster had NULL scope (legacy "all accounts"
-- behavior), the plan gets '{}' — the route layer treats empty
-- account_ids as "household-wide" the same way NULL did.
INSERT INTO budget_plans (tenant_id, name, period_type, anchor_date, account_ids)
SELECT DISTINCT ON (tenant_id, period_type)
       tenant_id,
       'Imported budget (' || period_type || ')' AS name,
       period_type,
       MIN(period_month) OVER (PARTITION BY tenant_id, period_type) AS anchor_date,
       COALESCE(
         (SELECT included_account_ids FROM budgets b2
            WHERE b2.tenant_id = b.tenant_id
              AND b2.period_type = b.period_type
              AND b2.included_account_ids IS NOT NULL
            LIMIT 1),
         '{}'::uuid[]
       ) AS account_ids
  FROM budgets b;

UPDATE budgets b
   SET plan_id = p.id
  FROM budget_plans p
 WHERE b.tenant_id = p.tenant_id
   AND b.period_type = p.period_type
   AND b.plan_id IS NULL;

COMMENT ON TABLE budget_plans IS
  '0.17.16 — one row per paycheck-to-paycheck budget cycle. A tenant can have many; each is scoped to a disjoint set of accounts.';
COMMENT ON COLUMN budgets.plan_id IS
  '0.17.16 — FK to the plan that owns this per-period row. NULL allowed for legacy ad-hoc rows created via POST /api/budgets, but new wizard runs always stamp it.';
