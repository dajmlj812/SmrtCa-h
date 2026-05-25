-- Migration 042 (0.17.22): savings_account_id on budget_plans.
--
-- The savings suggestion in the wizard now offers four
-- leftover-based options (25/50/75/100% of post-deduction
-- leftover) plus Goal-required. The user picks which savings
-- account that money is destined for; the plan remembers it.
--
-- ON DELETE SET NULL — if the destination account is deleted,
-- the plan keeps working with savings as an unattached budget
-- target (matching how account_ids on bills/income behave).

ALTER TABLE budget_plans
  ADD COLUMN savings_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN budget_plans.savings_account_id IS
  '0.17.22 — destination account for this plan''s savings rows. Set in the wizard from the user''s configured savings accounts.';
