-- Migration 072 (0.22.2): credit-card payoff goals.
--
-- Two related additions:
--
-- 1. accounts.credit_limit_cents — per-account credit limit. Only
--    meaningful for type='credit_card', but allowed on any row
--    (NULL = unspecified). Drives the utilization-target math on
--    payoff goals (e.g. "pay down to 30% of total limit").
--
-- 2. savings_goals gains:
--      kind                    — 'savings' (existing default) or
--                                'payoff' (new). Distinguishes
--                                "accumulate up" vs "shrink down"
--                                so progress is computed and
--                                rendered correctly.
--      initial_amount_cents    — for payoff: snapshot of total
--                                balance across linked accounts at
--                                goal-creation time. progress =
--                                (initial - current) / (initial -
--                                target). NULL for savings goals.
--      linked_account_ids      — uuid[]; for payoff goals, the
--                                set of credit card accounts the
--                                goal tracks. The server SUMs
--                                their current balances on each
--                                read to get live progress
--                                (manual contributions can still
--                                override that for the cycle).
--      target_utilization_pct  — for payoff goals using the
--                                "X% utilization" target mode, the
--                                user's chosen ratio (e.g. 30.00).
--                                Stored alongside the computed
--                                target_amount_cents so we can
--                                recompute if limits change.
--                                NULL when the user picked $0.
--
--    target_amount_cents was CHECK > 0; payoff goals can target $0
--    (pay the card off completely) so we relax that to >= 0.

ALTER TABLE accounts
  ADD COLUMN credit_limit_cents bigint
    CHECK (credit_limit_cents IS NULL OR credit_limit_cents > 0);

COMMENT ON COLUMN accounts.credit_limit_cents IS
  '0.22.2 — credit limit in cents. Used by payoff goals targeting a percentage of total utilization; informational on other account types.';


ALTER TABLE savings_goals
  DROP CONSTRAINT IF EXISTS savings_goals_target_amount_cents_check;
ALTER TABLE savings_goals
  ADD CONSTRAINT savings_goals_target_amount_cents_check
    CHECK (target_amount_cents >= 0);

ALTER TABLE savings_goals
  ADD COLUMN kind text NOT NULL DEFAULT 'savings'
    CHECK (kind IN ('savings', 'payoff')),
  ADD COLUMN initial_amount_cents bigint
    CHECK (initial_amount_cents IS NULL OR initial_amount_cents >= 0),
  ADD COLUMN linked_account_ids uuid[],
  ADD COLUMN target_utilization_pct numeric(5,2)
    CHECK (target_utilization_pct IS NULL
        OR (target_utilization_pct >= 0 AND target_utilization_pct <= 100));

COMMENT ON COLUMN savings_goals.kind IS
  '0.22.2 — savings (accumulate up, original behavior) or payoff (debt balance shrinks toward target).';
COMMENT ON COLUMN savings_goals.initial_amount_cents IS
  '0.22.2 — for payoff goals: total debt balance at creation time. progress = (initial - current) / (initial - target). NULL for savings goals.';
COMMENT ON COLUMN savings_goals.linked_account_ids IS
  '0.22.2 — for payoff goals: credit card accounts this goal tracks. Server SUMs current balances across these on read to compute live current_amount_cents.';
COMMENT ON COLUMN savings_goals.target_utilization_pct IS
  '0.22.2 — for payoff goals using the utilization-target mode: the ratio (0..100) the user wants to pay down to. Stored alongside the computed target so we can recompute if limits change.';
