-- Migration 026 (backlog 0.13.2): anomaly detection / alerts.
--
-- One row per detected anomaly. The (transaction_id, kind) UNIQUE
-- constraint means re-scanning the same transactions is idempotent —
-- the detector uses ON CONFLICT DO NOTHING so it can run safely after
-- every import + scheduled tick without piling up duplicate alerts.
--
-- Severities: 'info' / 'warn' / 'high'. Today only 'warn' and 'high'
-- are emitted; 'info' is reserved for future positive signals (e.g.
-- you stayed under budget all month).

CREATE TABLE anomaly_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id  uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN (
    'large_amount',
    'unusual_at_merchant',
    'duplicate_suspect'
  )),
  severity        text NOT NULL DEFAULT 'warn' CHECK (severity IN (
    'info', 'warn', 'high'
  )),
  message         text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  dismissed       boolean NOT NULL DEFAULT false,
  dismissed_at    timestamptz,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, kind)
);
CREATE INDEX anomaly_alerts_tenant_open_idx
  ON anomaly_alerts (tenant_id) WHERE dismissed = false;
CREATE INDEX anomaly_alerts_txn_idx
  ON anomaly_alerts (transaction_id);
