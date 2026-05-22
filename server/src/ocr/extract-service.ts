import { pool } from '../db/pool.js';
import type { OcrProvider } from './types.js';

/**
 * Run OCR on one attachment and persist the result. Designed to be called
 * fire-and-forget AFTER the upload response is sent — failures are caught
 * and stored on the row (status='failed' with the error in ocr_note) so the
 * UI can surface them.
 *
 * Future enhancement: replace this with a real background worker that
 * picks up pending attachments off a queue and survives process restarts.
 */
export async function runOcrExtraction(
  attachmentId: string,
  provider: OcrProvider,
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<void> {
  try {
    const result = await provider.extract({ buffer, mimeType, filename });
    await pool.query(
      `UPDATE attachments
          SET extracted_amount_cents = $1,
              extracted_date         = $2,
              extracted_merchant     = $3,
              ocr_provider           = $4,
              ocr_status             = 'extracted',
              ocr_note               = $5
        WHERE id = $6`,
      [
        result.amountCents,
        result.date,
        result.merchant,
        provider.id,
        result.note,
        attachmentId,
      ],
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
    await pool.query(
      `UPDATE attachments
          SET ocr_provider = $1,
              ocr_status   = 'failed',
              ocr_note     = $2
        WHERE id = $3`,
      [provider.id, message, attachmentId],
    );
    // Re-throw so the caller (.catch on the fire-and-forget call) can log it.
    throw err;
  }
}

/**
 * Mark an attachment as 'skipped' — used when no OCR provider is available
 * (rules/ollama/none) so the row doesn't sit forever in 'pending'.
 */
export async function markOcrSkipped(attachmentId: string): Promise<void> {
  await pool.query(
    `UPDATE attachments
        SET ocr_status = 'skipped',
            ocr_note   = 'No OCR provider configured'
      WHERE id = $1 AND ocr_status = 'pending'`,
    [attachmentId],
  );
}
