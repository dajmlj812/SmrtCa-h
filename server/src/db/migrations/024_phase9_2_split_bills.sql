-- Migration 024: Phase 9.2 — bill-splitting / shared expenses.
--
-- Distinct from the existing `transaction_splits` table, which is
-- CATEGORY splitting (one transaction → many category allocations).
-- This migration adds PERSON splitting (one transaction → many people
-- each owe a share).
--
-- Sign convention for share_cents: positive = the participant owes
-- you; negative = you owe the participant. The tenant's own share
-- (whatever's left after the others) is NOT stored — it's implied
-- as `transaction.amount_cents - sum(shares.share_cents)` so a
-- shifting amount on the source transaction can't desync the
-- accounting.

CREATE TABLE split_participants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text,
  -- When the participant happens to be a SmrtCash user themselves
  -- (e.g. a spouse on the same tenant, or a roommate with their own
  -- account), this links the two. Optional — a participant can be
  -- "Mom" who's not in the app at all.
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX split_participants_tenant_idx ON split_participants (tenant_id);

CREATE TABLE transaction_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES split_participants(id) ON DELETE CASCADE,
  -- Positive = participant owes the tenant. Negative = tenant owes
  -- the participant. Zero allowed for explicit "they paid in full
  -- already" rows that document a settlement.
  share_cents     bigint NOT NULL,
  settled         boolean NOT NULL DEFAULT false,
  settled_at      timestamptz,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, participant_id)
);
CREATE INDEX transaction_shares_txn_idx ON transaction_shares (transaction_id);
CREATE INDEX transaction_shares_participant_idx ON transaction_shares (participant_id);
CREATE INDEX transaction_shares_open_idx ON transaction_shares (participant_id)
  WHERE settled = false;
