-- Migration 068 (0.21.6): manual subscription cancellation queue.
--
-- Per the legal-risk review on 0.21.6, this slice deliberately
-- does NOT automate cancellations against vendor sites. Instead,
-- it gives the user a structured place to track WHICH
-- subscriptions they're trying to cancel, with status transitions
-- they update themselves:
--
--   queued        — added to the list, haven't started yet
--   in_progress   — clicked through to vendor, mid-flow
--   done          — successfully cancelled
--   couldnt       — vendor refused / dark-pattern blocked the flow
--   abandoned     — gave up; will retry later or accept the charge
--
-- bill_id is optional — the user may queue a "cancel this thing"
-- before they've matched it to a recurring bill in our system.

CREATE TABLE cancellation_queue (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bill_id         UUID         NULL REFERENCES bills(id) ON DELETE SET NULL,
  service_name    TEXT         NOT NULL,
  status          TEXT         NOT NULL DEFAULT 'queued',
  cancel_url      TEXT         NULL,
  notes           TEXT         NULL,
  monthly_cents   BIGINT       NULL,
  added_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ  NULL,
  completed_at    TIMESTAMPTZ  NULL,
  CONSTRAINT cancellation_queue_status_check CHECK (status IN (
    'queued', 'in_progress', 'done', 'couldnt', 'abandoned'
  )),
  CONSTRAINT cancellation_queue_service_nonempty CHECK (length(trim(service_name)) > 0)
);

CREATE INDEX cancellation_queue_tenant_open_idx
  ON cancellation_queue (tenant_id, status, added_at DESC)
  WHERE status IN ('queued', 'in_progress');

COMMENT ON TABLE cancellation_queue IS
  '0.21.6 — user-driven cancellation tracker. NO server-side automation against vendor sites; the user works through the queue themselves, we just remember status.';
