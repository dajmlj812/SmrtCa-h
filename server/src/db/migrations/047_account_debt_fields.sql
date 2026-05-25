-- Migration 047 (0.18.6): debt-related fields on accounts.
--
-- Powers the new /debt-payoff view that computes snowball /
-- avalanche payoff plans for accounts of type
-- IN ('loan', 'credit_card'). Both fields are nullable — a user
-- with no APR + no minimum-payment data still sees the page but
-- the row prompts them to fill the values in.

ALTER TABLE accounts
  ADD COLUMN interest_rate_apr numeric(6,3)
    CHECK (interest_rate_apr IS NULL
        OR (interest_rate_apr >= 0 AND interest_rate_apr <= 100)),
  ADD COLUMN min_payment_cents bigint
    CHECK (min_payment_cents IS NULL OR min_payment_cents > 0);

COMMENT ON COLUMN accounts.interest_rate_apr IS
  '0.18.6 — annual interest rate as a percent (e.g. 24.99 for a credit card). Used by the payoff plan calculator.';
COMMENT ON COLUMN accounts.min_payment_cents IS
  '0.18.6 — required minimum payment per month. Used as the floor for the payoff plan.';
