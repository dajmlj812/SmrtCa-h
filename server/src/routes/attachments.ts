import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';
import {
  AttachmentValidationError,
  deleteAttachmentFile,
  sanitizeFilename,
  storeAttachment,
  validateMimeType,
  validateSize,
} from '../attachments/storage.js';
import { getOcrProvider } from '../ocr/factory.js';
import {
  markOcrSkipped,
  runOcrExtraction,
} from '../ocr/extract-service.js';

interface AttachmentRow {
  id: string;
  transaction_id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  storage_path: string;
  created_at: string;
  extracted_amount_cents: number | null;
  extracted_date: string | null;
  extracted_merchant: string | null;
  ocr_provider: string | null;
  ocr_status: string;
  ocr_note: string | null;
}

const PUBLIC_COLUMNS = `id, transaction_id, filename, mime_type, byte_size,
  created_at, extracted_amount_cents, extracted_date, extracted_merchant,
  ocr_provider, ocr_status, ocr_note`;

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/transactions/:id/attachments',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      const result = await query<AttachmentRow>(
        `SELECT ${PUBLIC_COLUMNS}
           FROM attachments
          WHERE transaction_id = $1
       ORDER BY created_at`,
        [req.params.id],
      );
      return { attachments: result.rows };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/transactions/:id/attachments',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      // Verify the transaction exists before accepting any files.
      const txn = await query('SELECT id FROM transactions WHERE id = $1', [
        req.params.id,
      ]);
      if (txn.rowCount === 0) {
        return reply.code(404).send({ error: 'Transaction not found' });
      }

      const created: AttachmentRow[] = [];
      const errors: string[] = [];
      const pendingOcr: Array<{
        id: string;
        buffer: Buffer;
        mimeType: string;
        filename: string;
      }> = [];

      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        const reportedName = part.filename ?? 'upload';
        // Always drain the part's stream first — @fastify/multipart blocks
        // the iterator if a previous file part is left unconsumed. So we
        // read the buffer BEFORE any validation that might throw.
        const buffer = await part.toBuffer();
        try {
          validateMimeType(part.mimetype);
          validateSize(buffer.byteLength);

          const attachmentId = randomUUID();
          const { storagePath, byteSize, safeFilename } = await storeAttachment(
            attachmentId,
            reportedName,
            part.mimetype,
            buffer,
          );

          // The row starts as 'pending' (default); the OCR step below either
          // updates it to 'extracted'/'failed' (Claude) or 'skipped' (no
          // provider). Either way, no row sits at 'pending' after the
          // response is sent.
          const insert = await query<AttachmentRow>(
            `INSERT INTO attachments
               (id, transaction_id, filename, mime_type, byte_size, storage_path)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING ${PUBLIC_COLUMNS}`,
            [
              attachmentId,
              req.params.id,
              safeFilename,
              part.mimetype,
              byteSize,
              storagePath,
            ],
          );
          created.push(insert.rows[0]!);
          pendingOcr.push({
            id: attachmentId,
            buffer,
            mimeType: part.mimetype,
            filename: safeFilename,
          });
        } catch (err) {
          const message =
            err instanceof AttachmentValidationError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          errors.push(`${sanitizeFilename(reportedName)}: ${message}`);
        }
      }

      if (created.length === 0) {
        return reply.code(400).send({
          error: errors.length > 0 ? errors.join('; ') : 'No file uploaded',
        });
      }

      const ocrProvider = getOcrProvider();
      if (ocrProvider) {
        // Fire-and-forget — the upload response returns immediately with
        // status='pending', and the UI polls the list endpoint to pick up
        // the extracted fields when OCR completes.
        for (const item of pendingOcr) {
          void runOcrExtraction(
            item.id,
            ocrProvider,
            item.buffer,
            item.mimeType,
            item.filename,
          ).catch((err) => {
            req.log.warn(
              { err, attachmentId: item.id },
              'Background OCR extraction failed',
            );
          });
        }
      } else {
        // No vision provider — mark every row 'skipped' synchronously so
        // the response reflects the final state (no UI polling needed).
        for (const item of pendingOcr) {
          await markOcrSkipped(item.id);
        }
        for (const row of created) {
          row.ocr_status = 'skipped';
          row.ocr_note = 'No OCR provider configured';
        }
      }

      return reply.code(201).send({
        attachments: created,
        ...(errors.length > 0 ? { errors } : {}),
      });
    },
  );

  // Download (forces attachment disposition so the browser saves the file).
  app.get<{ Params: { id: string } }>(
    '/api/attachments/:id',
    async (req, reply) => {
      const row = await loadAttachment(req.params.id);
      if (row === 'invalid') {
        return reply.code(400).send({ error: 'Invalid attachment id' });
      }
      if (!row) return reply.code(404).send({ error: 'Attachment not found' });

      reply.header('Content-Type', row.mime_type);
      reply.header(
        'Content-Disposition',
        `attachment; filename="${row.filename}"`,
      );
      return reply.send(createReadStream(row.storage_path));
    },
  );

  // Inline preview (browser renders directly — for <img src=…> and PDF embeds).
  app.get<{ Params: { id: string } }>(
    '/api/attachments/:id/preview',
    async (req, reply) => {
      const row = await loadAttachment(req.params.id);
      if (row === 'invalid') {
        return reply.code(400).send({ error: 'Invalid attachment id' });
      }
      if (!row) return reply.code(404).send({ error: 'Attachment not found' });

      reply.header('Content-Type', row.mime_type);
      reply.header(
        'Content-Disposition',
        `inline; filename="${row.filename}"`,
      );
      return reply.send(createReadStream(row.storage_path));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/attachments/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid attachment id' });
      }
      const result = await query<{ storage_path: string }>(
        `DELETE FROM attachments WHERE id = $1 RETURNING storage_path`,
        [req.params.id],
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Attachment not found' });
      }
      // Best-effort filesystem cleanup — the DB row is the source of truth.
      try {
        await deleteAttachmentFile(result.rows[0]!.storage_path);
      } catch (err) {
        req.log.warn(
          { err },
          'Failed to remove attachment file from disk; the DB row is gone.',
        );
      }
      return reply.code(204).send();
    },
  );
}

type LoadResult =
  | (AttachmentRow & { storage_path: string })
  | null
  | 'invalid';

async function loadAttachment(id: string): Promise<LoadResult> {
  if (!isUuid(id)) return 'invalid';
  const result = await query<AttachmentRow & { storage_path: string }>(
    `SELECT ${PUBLIC_COLUMNS}, storage_path
       FROM attachments WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}
