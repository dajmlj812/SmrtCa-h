-- Migration 030 (0.15.0): SaaS subscriptions + usage counters.
--
-- One subscription per tenant (PK on tenant_id). Mirrors Stripe's
-- subscription state machine so the webhook can simply UPSERT what
-- Stripe sent us. Status values are exactly Stripe's set so a
-- `subscription.status` field on the webhook can land directly in
-- the column without translation.
--
-- See docs/SAAS_PLAN.md for the pricing tiers and feature gating
-- this powers.

CREATE TABLE subscriptions (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Stripe identifiers. Both nullable so we can create a placeholder
  -- row during signup BEFORE the Stripe Checkout session completes
  -- (rare but possible — webhook always fills these in).
  stripe_customer_id     text UNIQUE,
  stripe_subscription_id text UNIQUE,
  -- Our plan keys: 'starter', 'plus', 'family'.
  plan_id                text NOT NULL
    CHECK (plan_id IN ('starter', 'plus', 'family')),
  -- Stripe subscription status — literal mirror.
  --   trialing: in free trial; treated as fully entitled.
  --   active: paid + healthy; treated as fully entitled.
  --   past_due: invoice payment failed; entitled during a grace
  --     window (handled at the route layer in 0.15.4).
  --   canceled: subscription ended; not entitled (unless still
  --     before current_period_end with cancel_at_period_end=true).
  --   incomplete / incomplete_expired / unpaid / paused: not
  --     entitled; rare paths from Stripe.
  status                 text NOT NULL
    CHECK (status IN (
      'trialing','active','past_due','canceled',
      'incomplete','incomplete_expired','unpaid','paused'
    )),
  trial_end              timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Per-tenant metered usage counters for AI assistant tool calls and
-- OCR receipt processing. Keyed on the subscription's billing period
-- so quotas reset cleanly when Stripe advances `current_period_end`.
-- We never delete rows — historical counts are useful for
-- usage-pricing experiments and customer-facing usage charts.
--
-- The PK is (tenant_id, feature_key, period_start). Routes that
-- consume quota use:
--   INSERT ... ON CONFLICT (tenant_id, feature_key, period_start)
--     DO UPDATE SET count = usage_counters.count + EXCLUDED.count
--     RETURNING count;
-- which is atomic and returns the new total in one round-trip.
CREATE TABLE usage_counters (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key   text NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  count         integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (tenant_id, feature_key, period_start)
);

-- Stripe webhook idempotency. Each delivered event has a unique id;
-- we record processed ones so a retry from Stripe (or a duplicate
-- delivery) is a no-op rather than re-applying the side effect.
-- Used by 0.15.1. Created here so the schema is complete in one
-- migration.
CREATE TABLE stripe_processed_events (
  event_id     text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Helpful index for the typical query: "what's tenant X's status?"
-- already covered by the PK. No separate index needed.
