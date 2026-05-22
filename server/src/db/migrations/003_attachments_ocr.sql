-- Migration 003: extend attachments with OCR-extracted fields.
--
-- When an attachment is uploaded and the configured AI provider supports
-- vision, the receipt's amount / date / merchant are extracted and stored
-- here. The frontend uses them to flag receipts that don't match the
-- transaction they're attached to.

ALTER TABLE attachments
  ADD COLUMN extracted_amount_cents bigint,
  ADD COLUMN extracted_date         date,
  ADD COLUMN extracted_merchant     text,
  ADD COLUMN ocr_provider           text,
  ADD COLUMN ocr_status             text NOT NULL DEFAULT 'pending'
    CHECK (ocr_status IN ('pending', 'extracted', 'failed', 'skipped')),
  ADD COLUMN ocr_note               text;

-- Partial index for the background worker (Phase 3 enhancement) to find
-- attachments that still need OCR.
CREATE INDEX attachments_ocr_pending_idx
  ON attachments (created_at)
  WHERE ocr_status = 'pending';
