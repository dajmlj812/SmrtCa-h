-- Migration 064 (0.21.1): refund / chargeback tracking on transactions.
--
-- Mint had this; nobody in the current crop does. Common ask from
-- users tracking purchases they're disputing with the merchant or
-- the card issuer.
--
-- Lifecycle: a transaction begins with refund_status = NULL
-- (normal). The user marks it 'refund_pending' when they request
-- a refund, flips it to 'refunded' when the credit lands, or
-- escalates to 'chargeback_initiated' / 'disputed'. 'closed'
-- buckets the resolved-but-not-refunded case (denial, store
-- credit, etc.).

ALTER TABLE transactions
  ADD COLUMN refund_status TEXT NULL,
  ADD COLUMN refund_note TEXT NULL,
  ADD COLUMN refund_updated_at TIMESTAMPTZ NULL,
  ADD CONSTRAINT transactions_refund_status_check CHECK (
    refund_status IS NULL OR refund_status IN (
      'refund_pending', 'refunded',
      'chargeback_initiated', 'disputed', 'closed'
    )
  );

-- Partial index — most transactions never get a refund_status,
-- so a partial index keeps the index size and write overhead
-- minimal while still accelerating the "show me everything I
-- have open" view.
CREATE INDEX transactions_open_refund_idx
  ON transactions (refund_status)
  WHERE refund_status IS NOT NULL
    AND refund_status NOT IN ('refunded', 'closed');

COMMENT ON COLUMN transactions.refund_status IS
  '0.21.1 — refund/chargeback lifecycle. NULL = normal; otherwise: refund_pending → refunded | disputed | chargeback_initiated → closed.';
