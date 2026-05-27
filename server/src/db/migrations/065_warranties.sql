-- Migration 065 (0.21.2): receipt → warranty tracking.
--
-- One row per warrantied purchase: the item name, when the
-- warranty expires, optional links back to the source
-- transaction + receipt attachment, and an optional purchase
-- price for tracking total covered value. The expiry index is
-- the hot one — the daily insights scanner asks "what's
-- expiring in the next 30 days for this tenant" once per day.

CREATE TABLE warranties (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id  UUID         NULL REFERENCES transactions(id) ON DELETE SET NULL,
  attachment_id   UUID         NULL REFERENCES attachments(id) ON DELETE SET NULL,
  item            TEXT         NOT NULL,
  vendor          TEXT         NULL,
  purchase_date   DATE         NOT NULL,
  warranty_until  DATE         NOT NULL,
  purchase_cents  BIGINT       NULL,
  notes           TEXT         NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT warranties_dates_order CHECK (warranty_until >= purchase_date),
  CONSTRAINT warranties_item_nonempty CHECK (length(trim(item)) > 0)
);

-- NB: cannot use a CURRENT_DATE predicate here — Postgres requires
-- index WHERE clauses to be IMMUTABLE. A full-table index is fine
-- given warranty row counts are small.
CREATE INDEX warranties_tenant_expiry_idx
  ON warranties (tenant_id, warranty_until);

-- Lookups by attached transaction (e.g. "show warranty for this receipt").
CREATE INDEX warranties_transaction_idx
  ON warranties (transaction_id)
  WHERE transaction_id IS NOT NULL;

COMMENT ON TABLE warranties IS
  '0.21.2 — warranty/return-window tracking. Daily scheduler emits an insight card when warranty_until is within 30 days; the user gets a heads-up to return / extend / replace before coverage lapses.';
