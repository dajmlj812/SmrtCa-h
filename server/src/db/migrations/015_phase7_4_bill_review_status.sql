-- Migration 015: Phase 7.4 — subscription review queue.
--
-- bills (which is also where confirmed recurring suggestions land) gains
-- a small review workflow so the user can mark a recurring expense as
-- "needs attention" and pick an action: cancel the service, alter it,
-- or keep it as-is. The 'active' subscriptions live as 'active'; the
-- review queue is everything in {'review','cancel','alter'} — 'keep' is
-- a closed-out review.
--
-- review_note is free text the user can drop on the row to capture
-- context ("I never used Hulu", "downgrade to ad-tier", etc).
-- last_reviewed_at is bumped each time the status moves so a "reviewed
-- 30 days ago" sort works.

ALTER TABLE bills
  ADD COLUMN review_status text NOT NULL DEFAULT 'active'
    CHECK (review_status IN ('active','review','cancel','alter','keep')),
  ADD COLUMN review_note text,
  ADD COLUMN last_reviewed_at timestamptz;

CREATE INDEX bills_review_status_idx ON bills (review_status)
  WHERE review_status <> 'active';
