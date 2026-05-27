-- Migration 066 (0.21.2): extend insight_cards.kind for warranties.
--
-- The 0.21.2 daily insights scan emits a 'warranty_expiring' card
-- when a tenant's warranty is within 30 days of warranty_until. Add
-- the kind to the CHECK so inserts succeed.

ALTER TABLE insight_cards
  DROP CONSTRAINT IF EXISTS insight_cards_kind_check;

ALTER TABLE insight_cards
  ADD CONSTRAINT insight_cards_kind_check CHECK (kind IN (
    'anomaly',
    'budget_overrun_trend',
    'goal_pace_slipping',
    'unusual_recurring_charge',
    'cash_flow_warning',
    'fee_drag',
    'warranty_expiring'
  ));
