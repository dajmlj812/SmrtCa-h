-- Migration 067 (0.21.3): non-traditional household models.
--
-- Real households aren't always one couple sharing every account.
-- Three primitives that cover the common cases:
--
--   • household_participants — named people within a tenant
--     (kind: spouse, child, co_parent, roommate, dependent). These
--     are LABELS, not full user accounts — a participant doesn't
--     need to log in. (A real cross-tenant link is its own feature;
--     see [[cross-tenant-invites]].)
--
--   • account_splits — assigns one account across N participants
--     by percentage. A joint checking account at 50/50 between two
--     spouses; a kid's allowance account at 100% the child; a
--     roommate utility account at 33/33/34. Sum must == 100 when
--     non-empty, enforced at the application layer because PG
--     triggers across rows of a child table are gnarly.
--
--   • custody_periods — for separated co-parents who alternate
--     who's responsible for shared expenses, a date-ranged
--     "this account belongs to participant X from date A to date B".
--     The reports view sees overlapping rules and assigns each
--     transaction to whichever rule covers its txn_date (latest
--     wins on ties).

CREATE TABLE household_participants (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT         NOT NULL,
  kind          TEXT         NOT NULL DEFAULT 'other',
  email         TEXT         NULL,
  color         TEXT         NULL,
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT household_participants_kind_check CHECK (kind IN (
    'spouse', 'child', 'co_parent', 'roommate', 'dependent', 'other'
  )),
  CONSTRAINT household_participants_name_nonempty CHECK (length(trim(name)) > 0)
);

CREATE INDEX household_participants_tenant_idx
  ON household_participants (tenant_id, active);

CREATE TABLE account_splits (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id     UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  participant_id UUID         NOT NULL REFERENCES household_participants(id) ON DELETE CASCADE,
  split_pct      NUMERIC(6,3) NOT NULL CHECK (split_pct > 0 AND split_pct <= 100),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (account_id, participant_id)
);

CREATE INDEX account_splits_account_idx
  ON account_splits (account_id);
CREATE INDEX account_splits_participant_idx
  ON account_splits (participant_id);

CREATE TABLE custody_periods (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id     UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  participant_id UUID         NOT NULL REFERENCES household_participants(id) ON DELETE CASCADE,
  start_date     DATE         NOT NULL,
  end_date       DATE         NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT custody_periods_dates_order CHECK (
    end_date IS NULL OR end_date >= start_date
  )
);

CREATE INDEX custody_periods_account_range_idx
  ON custody_periods (account_id, start_date, end_date);

COMMENT ON TABLE household_participants IS
  '0.21.3 — named members of a household (spouse, child, co-parent, roommate). Used by account_splits + custody_periods to split shared finances across people.';
COMMENT ON TABLE account_splits IS
  '0.21.3 — per-account percentage split across household participants. Sum across an account must = 100 when non-empty (enforced in app layer).';
COMMENT ON TABLE custody_periods IS
  '0.21.3 — date-ranged ownership of an account by a participant. Latest-start wins for overlapping rules. end_date NULL = open-ended (current).';
