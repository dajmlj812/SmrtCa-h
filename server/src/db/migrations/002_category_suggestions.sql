-- Migration 002: AI-suggested categories pending user validation.
--
-- When the AI normalizer returns a category that is not in the taxonomy,
-- the suggestion is captured here for the user to Approve / Merge / Reject.
-- The transactions that triggered the suggestion are tagged via the new
-- `suggested_category_name` column so each suggestion can show how many
-- transactions are waiting on it.

CREATE TABLE category_suggestions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggested_name          text NOT NULL,
  status                  text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'merged')),
  resolved_to_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz
);

-- At most one pending suggestion per name (case-insensitive). Resolved
-- entries are kept for audit and can coexist with a new pending one if
-- the AI proposes the same name again later.
CREATE UNIQUE INDEX category_suggestions_pending_unique
  ON category_suggestions (lower(suggested_name))
  WHERE status = 'pending';

CREATE INDEX category_suggestions_status_idx
  ON category_suggestions (status, created_at DESC);

ALTER TABLE transactions
  ADD COLUMN suggested_category_name text;

-- Partial index — most rows don't have a suggestion, no point indexing nulls.
CREATE INDEX transactions_suggested_category_idx
  ON transactions (suggested_category_name)
  WHERE suggested_category_name IS NOT NULL;
