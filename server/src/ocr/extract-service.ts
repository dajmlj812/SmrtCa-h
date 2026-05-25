import { pool } from '../db/pool.js';
import {
  type EncryptionVersion,
  readAttachmentBuffer,
} from '../attachments/storage.js';
import type { OcrProvider } from './types.js';

/**
 * Hard cap on a single OCR call. The Claude vision API normally finishes
 * in 60-90 seconds for a typical receipt; anything past 3 minutes
 * almost certainly means the upstream connection is wedged. Without
 * this cap, the row sits at ocr_status='pending' until the next server
 * restart triggers the sweepPendingOcr retry — and the user sees a
 * spinner that genuinely doesn't move.
 */
const OCR_TIMEOUT_MS = 180_000;

/**
 * Run OCR on one attachment and persist the result. Designed to be called
 * fire-and-forget AFTER the upload response is sent — failures are caught
 * and stored on the row (status='failed' with the error in ocr_note) so the
 * UI can surface them.
 *
 * Restart-safety: any attachment whose upload finished but whose extraction
 * didn't get to run (server crash mid-OCR) stays at ocr_status='pending'.
 * `sweepPendingOcr()` below retries those on the next boot.
 */
export async function runOcrExtraction(
  attachmentId: string,
  provider: OcrProvider,
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<void> {
  try {
    // Wrap with a hard timeout so a wedged Claude call resolves to
    // 'failed' instead of sitting at 'pending' until the next restart.
    // The provider doesn't expose an AbortSignal interface today so we
    // race the call against a setTimeout. The provider call keeps
    // running in the background if we lose the race — the only effect
    // is that the row is marked 'failed' so the UI moves on. (When the
    // late response eventually comes back, it'll resolve into the
    // already-stored 'failed' row's catch path and be discarded.)
    const result = await Promise.race([
      provider.extract({ buffer, mimeType, filename }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `OCR timed out after ${OCR_TIMEOUT_MS / 1000} seconds — provider did not respond. The image was saved; you can re-trigger OCR by re-uploading.`,
              ),
            ),
          OCR_TIMEOUT_MS,
        ),
      ),
    ]);
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

export interface SweepResult {
  scanned: number;
  extracted: number;
  failed: number;
}

/**
 * Restart-safe retry pass. Finds attachments still at ocr_status='pending'
 * that are at least `ageSeconds` old (default 60s — gives the in-process
 * fire-and-forget extraction time to finish) and re-runs OCR on each.
 *
 * Per-row failures are caught so one bad row never stops the sweep. Files
 * that have been deleted off disk get marked 'failed' with the I/O error.
 */
export async function sweepPendingOcr(
  provider: OcrProvider,
  opts: { ageSeconds?: number } = {},
): Promise<SweepResult> {
  const ageSeconds = opts.ageSeconds ?? 60;
  const candidates = await pool.query<{
    id: string;
    storage_path: string;
    mime_type: string;
    filename: string;
    encryption_version: number;
    tenant_id: string;
  }>(
    `SELECT id, storage_path, mime_type, filename, encryption_version, tenant_id
       FROM attachments
      WHERE ocr_status = 'pending'
        AND created_at < now() - make_interval(secs => $1::int)`,
    [ageSeconds],
  );

  let extracted = 0;
  let failed = 0;
  for (const row of candidates.rows) {
    try {
      // 0.16.4 — pass tenant_id so v2 (envelope-encrypted) rows
      // resolve their per-tenant DEK. v0/v1 rows ignore it.
      const buffer = await readAttachmentBuffer(
        row.storage_path,
        row.encryption_version as EncryptionVersion,
        row.tenant_id,
      );
      await runOcrExtraction(
        row.id,
        provider,
        buffer,
        row.mime_type,
        row.filename,
      );
      extracted++;
    } catch (err) {
      // runOcrExtraction already wrote 'failed' if it got past the read.
      // For an upstream error (e.g. missing file), mark it ourselves —
      // the WHERE clause no-ops if the row was already updated.
      const message =
        err instanceof Error
          ? err.message.slice(0, 500)
          : String(err).slice(0, 500);
      await pool.query(
        `UPDATE attachments
            SET ocr_status = 'failed',
                ocr_note   = $1
          WHERE id = $2 AND ocr_status = 'pending'`,
        [message, row.id],
      );
      failed++;
    }
  }
  return { scanned: candidates.rows.length, extracted, failed };
}
