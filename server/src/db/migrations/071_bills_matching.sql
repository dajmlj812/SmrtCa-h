-- Migration 071 (0.22.0): bill matching engine + per-period state.
--
-- Three things land here:
--
-- 1. `bills.kind` — the UX has historically had a Bills page and a
--    Subscriptions page that both read from this same table. 0.22.0
--    merges them into /recurring, so we add an explicit kind flag for
--    filtering. Existing rows default to 'bill'; the user can re-tag
--    any row as 'subscription' from the unified page.
--
-- 2. Matching fields. Each bill declares HOW the matcher should
--    decide a transaction is its payment:
--      • amount_mode = 'fixed'    → ±$1 OR ±2%, whichever is larger
--      • amount_mode = 'drift'    → trailing-3-month average ±10%,
--                                   falls back to amount_cents ±10%
--                                   until 3 cycles of history exist
--      • amount_mode = 'variable' → any amount ≤ amount_tolerance_cents
--                                   (absolute cap — interpreted as
--                                   the most you'd ever expect to see)
--    match_window_days is the ± window around next_due_date. Default
--    ±7, per-bill override.
--    merchant_pattern is a case-insensitive substring matched against
--    the transaction description; initialized from bills.name so the
--    matcher does something useful on day one (opportunistic).
--    paused_until indefinitely suppresses matching + overdue alerts.
--    overdue_grace_days is the number of days past due_date before
--    a pending period flips to overdue.
--
-- 3. bill_periods — per-cycle status history. The existing
--    bills.next_due_date is just a cursor that advances when paid;
--    we need to remember each PAST period (was August's electric bill
--    actually matched, or did the user mark it skipped?). PK is
--    (bill_id, period_anchor_date) so re-running the matcher is
--    idempotent.
--
--    bill_match_triage queues ambiguous candidates the matcher
--    refused to auto-link. The user resolves each (accept link /
--    reject) from the /recurring triage section.

ALTER TABLE bills
  ADD COLUMN kind                   text NOT NULL DEFAULT 'bill'
    CHECK (kind IN ('bill','subscription')),
  ADD COLUMN amount_mode            text NOT NULL DEFAULT 'fixed'
    CHECK (amount_mode IN ('fixed','drift','variable')),
  ADD COLUMN amount_tolerance_cents bigint
    CHECK (amount_tolerance_cents IS NULL OR amount_tolerance_cents > 0),
  ADD COLUMN match_window_days      integer NOT NULL DEFAULT 7
    CHECK (match_window_days BETWEEN 1 AND 30),
  ADD COLUMN merchant_pattern       text,
  ADD COLUMN paused_until           date,
  ADD COLUMN overdue_grace_days     integer NOT NULL DEFAULT 3
    CHECK (overdue_grace_days BETWEEN 0 AND 30);

-- Opportunistic matching for existing rows: use the bill's name as
-- the initial merchant pattern. Users can refine on the row.
UPDATE bills SET merchant_pattern = name WHERE merchant_pattern IS NULL;

COMMENT ON COLUMN bills.kind IS
  '0.22.0 — UX tag: bill (utility, mortgage, one-off recurring) or subscription (Netflix, SaaS). Drives the /recurring filter tabs.';
COMMENT ON COLUMN bills.amount_mode IS
  '0.22.0 — how the matcher decides amount fit. fixed: ±$1 or ±2%. drift: trailing-3mo avg ±10%. variable: any amount ≤ amount_tolerance_cents.';
COMMENT ON COLUMN bills.amount_tolerance_cents IS
  '0.22.0 — absolute upper bound for variable mode (e.g. 50000 = $500 for an energy bill that swings $250-$400). Ignored when amount_mode <> ''variable''.';
COMMENT ON COLUMN bills.match_window_days IS
  '0.22.0 — ± days around next_due_date a transaction must fall within to be considered a match.';
COMMENT ON COLUMN bills.merchant_pattern IS
  '0.22.0 — case-insensitive substring matched against transaction.description. NULL disables auto-matching for this bill.';
COMMENT ON COLUMN bills.paused_until IS
  '0.22.0 — when set, the bill is paused: matcher skips it and overdue alerts are suppressed until this date passes.';
COMMENT ON COLUMN bills.overdue_grace_days IS
  '0.22.0 — days past due_date before a still-pending period flips to overdue (and emits an insight card).';


-- Per-period status history. A row is created when the matcher first
-- considers a period (either it lands a match, or the period passes
-- with no match, or the user skips it manually). next_due_date on
-- the parent bill remains the forward-looking cursor; this table is
-- the backward-looking ledger.
CREATE TABLE bill_periods (
  bill_id            uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  -- The expected due date for this cycle (NOT the date paid). Lets
  -- us answer "was July's bill paid?" without ambiguity if the
  -- charge cleared on Aug 2.
  period_anchor_date date NOT NULL,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','overdue','skipped')),
  matched_txn_id     uuid REFERENCES transactions(id) ON DELETE SET NULL,
  marked_paid_at     timestamptz,
  skipped_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bill_id, period_anchor_date)
);

CREATE INDEX bill_periods_tenant_status_idx
  ON bill_periods (tenant_id, status)
  WHERE status IN ('pending','overdue');
CREATE INDEX bill_periods_matched_txn_idx
  ON bill_periods (matched_txn_id)
  WHERE matched_txn_id IS NOT NULL;

COMMENT ON TABLE bill_periods IS
  '0.22.0 — per-cycle status for each bill. Lets the /recurring page show "August: paid / September: pending / October: pending" without inferring from transaction history every time.';


-- Triage queue: matches the engine wasn't confident enough to make
-- automatically. The user resolves each row from a /recurring section.
CREATE TABLE bill_match_triage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The candidate bill the matcher considered. When the reason is
  -- 'ambiguous_vendor' there are MULTIPLE candidates, but we still
  -- write one triage row per (bill, txn) pair so the user can pick.
  bill_id         uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  transaction_id  uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  -- Why the matcher punted on this pair.
  reason          text NOT NULL
    CHECK (reason IN ('ambiguous_vendor','amount_edge','date_edge','out_of_tolerance')),
  -- Outer-25%-of-window flag for the UI to highlight near-misses.
  amount_fit      numeric(5,4),
  date_fit        numeric(5,4),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  -- 'accepted' = user said yes, link it (engine then writes the
  -- bill_periods row + flips status to paid).
  -- 'rejected' = user said no, this txn is not that bill.
  -- 'reassigned' = user picked a DIFFERENT bill from the ambiguous
  -- set; the chosen one gets accepted, the others auto-rejected.
  resolution      text
    CHECK (resolution IS NULL OR resolution IN ('accepted','rejected','reassigned')),
  UNIQUE (bill_id, transaction_id)
);

CREATE INDEX bill_match_triage_open_idx
  ON bill_match_triage (tenant_id)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE bill_match_triage IS
  '0.22.0 — matcher candidates that did not auto-link (ambiguous vendor, edge-of-window amount, or edge-of-window date). User resolves from the /recurring triage section.';
