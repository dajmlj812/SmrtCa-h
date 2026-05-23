-- Migration 009: Phase 6.2 — learned normalization rules + transaction splits.
--
-- Two new tables:
--
-- 1. normalization_rules — captured from manual edits. When the user
--    changes a transaction's merchant or category and accepts the
--    "Apply to similar?" prompt, a row lands here. The pattern is a
--    case-insensitive substring matched against raw_description. The
--    rule runs against non-manual transactions automatically (on every
--    import and on /api/normalization-rules/apply) and persists across
--    sessions so AI-driven normalization never undoes a learned rule.
--
-- 2. transaction_splits — break a single transaction into per-category
--    slices. The transaction row keeps its original amount + category;
--    when at least one split row exists, downstream insights queries
--    expand the transaction into the per-split lines.
--
-- The application enforces sum(splits.amount_cents) = transaction.amount_cents.

CREATE TABLE normalization_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern             text NOT NULL,
  normalized_merchant text,
  category_id         uuid REFERENCES categories(id) ON DELETE SET NULL,
  source              text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','ai')),
  match_count         bigint NOT NULL DEFAULT 0,
  last_applied_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- A rule must do *something* — either set a merchant, a category, or both.
  CONSTRAINT normalization_rules_has_effect
    CHECK (normalized_merchant IS NOT NULL OR category_id IS NOT NULL)
);
-- Same pattern can't be registered twice (case-insensitive).
CREATE UNIQUE INDEX normalization_rules_pattern_unique
  ON normalization_rules (lower(pattern));

CREATE TABLE transaction_splits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id    uuid REFERENCES categories(id) ON DELETE SET NULL,
  amount_cents   bigint NOT NULL CHECK (amount_cents <> 0),
  memo           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_splits_txn_idx ON transaction_splits (transaction_id);
