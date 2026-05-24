import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';
import {
  assertAttachmentInTenant,
  assertTransactionInTenant,
  requireTenant,
} from '../auth/rbac.js';
import {
  AttachmentValidationError,
  type EncryptionVersion,
  MAX_REQUEST_BYTES,
  deleteAttachmentFile,
  readAttachmentBuffer,
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
  encryption_version: number;
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

/**
 * 0.14.3 — attachments hardening.
 *
 * Pre-0.14.3 the download/preview routes loaded + DECRYPTED any
 * attachment by id with zero ownership check — a single id-guess
 * could exfiltrate any tenant's receipts. Now every read and write
 * verifies the attached transaction (and through it, the account)
 * belongs to the caller's tenant. Cross-tenant ids return 404 with
 * the same shape as a stale/unknown id.
 *
 * The list endpoint also adds the txn-ownership gate so a tenant
 * can't enumerate another tenant's attachment ids via a known
 * transaction id.
 */
export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/transactions/:id/attachments',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      const ok = await assertTransactionInTenant(tenantId, req.params.id);
      if (!ok) return reply.code(404).send({ error: 'Transaction not found' });
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
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      // Verify the transaction exists AND belongs to this tenant
      // before accepting any files. 0.14.3 closes the pre-fix gap
      // where the existence check ignored tenant ownership.
      const ok = await assertTransactionInTenant(tenantId, req.params.id);
      if (!ok) return reply.code(404).send({ error: 'Transaction not found' });

      const errors: string[] = [];
      interface StagedPart {
        reportedName: string;
        mimeType: string;
        buffer: Buffer;
      }
      const staged: StagedPart[] = [];
      let totalBytes = 0;

      // Phase 1 — drain every part into memory, validate per-file, and
      // refuse the whole request if the aggregate goes over the cap. No
      // disk or DB writes happen until we know the upload is acceptable.
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        const reportedName = part.filename ?? 'upload';
        const buffer = await part.toBuffer();
        try {
          validateMimeType(part.mimetype);
          validateSize(buffer.byteLength);
        } catch (err) {
          const message =
            err instanceof AttachmentValidationError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          errors.push(`${sanitizeFilename(reportedName)}: ${message}`);
          continue;
        }
        totalBytes += buffer.byteLength;
        if (totalBytes > MAX_REQUEST_BYTES) {
          return reply.code(413).send({
            error: `Total upload size exceeds the ${MAX_REQUEST_BYTES}-byte aggregate cap.`,
          });
        }
        staged.push({ reportedName, mimeType: part.mimetype, buffer });
      }

      if (staged.length === 0) {
        return reply.code(400).send({
          error: errors.length > 0 ? errors.join('; ') : 'No file uploaded',
        });
      }

      // Phase 2 — write to disk and DB. INSERT now writes `tenant_id`
      // so per-tenant tooling can rely on it without a transaction
      // join. Phase 8 added the column nullable; pre-0.14.3 nothing
      // populated it.
      const created: AttachmentRow[] = [];
      const pendingOcr: Array<{
        id: string;
        buffer: Buffer;
        mimeType: string;
        filename: string;
      }> = [];
      for (const item of staged) {
        const attachmentId = randomUUID();
        const { storagePath, byteSize, safeFilename, encryptionVersion } =
          await storeAttachment(
            attachmentId,
            item.reportedName,
            item.mimeType,
            item.buffer,
          );
        const insert = await query<AttachmentRow>(
          `INSERT INTO attachments
             (id, tenant_id, transaction_id, filename, mime_type, byte_size,
              storage_path, encryption_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${PUBLIC_COLUMNS}`,
          [
            attachmentId,
            tenantId,
            req.params.id,
            safeFilename,
            item.mimeType,
            byteSize,
            storagePath,
            encryptionVersion,
          ],
        );
        created.push(insert.rows[0]!);
        pendingOcr.push({
          id: attachmentId,
          buffer: item.buffer,
          mimeType: item.mimeType,
          filename: safeFilename,
        });
      }

      const ocrProvider = getOcrProvider();
      if (ocrProvider) {
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

  // Download — every read of attachment bytes requires the attachment
  // belong to this tenant. Pre-0.14.3 this route decrypted any
  // attachment by id, leaking receipt PDFs cross-tenant.
  app.get<{ Params: { id: string } }>(
    '/api/attachments/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const row = await loadScopedAttachment(req.params.id, tenantId);
      if (row === 'invalid') {
        return reply.code(400).send({ error: 'Invalid attachment id' });
      }
      if (!row) return reply.code(404).send({ error: 'Attachment not found' });

      const buffer = await readAttachmentBuffer(
        row.storage_path,
        row.encryption_version as EncryptionVersion,
      );
      reply.header('Content-Type', row.mime_type);
      reply.header(
        'Content-Disposition',
        `attachment; filename="${row.filename}"`,
      );
      reply.header('Content-Length', buffer.length);
      return reply.send(buffer);
    },
  );

  // Inline preview — same scope check as download.
  app.get<{ Params: { id: string } }>(
    '/api/attachments/:id/preview',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const row = await loadScopedAttachment(req.params.id, tenantId);
      if (row === 'invalid') {
        return reply.code(400).send({ error: 'Invalid attachment id' });
      }
      if (!row) return reply.code(404).send({ error: 'Attachment not found' });

      const buffer = await readAttachmentBuffer(
        row.storage_path,
        row.encryption_version as EncryptionVersion,
      );
      reply.header('Content-Type', row.mime_type);
      reply.header(
        'Content-Disposition',
        `inline; filename="${row.filename}"`,
      );
      reply.header('Content-Length', buffer.length);
      return reply.send(buffer);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/attachments/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid attachment id' });
      }
      // Ownership check via assertAttachmentInTenant before deleting
      // ensures the cross-tenant path returns 404 with no file removed.
      const ok = await assertAttachmentInTenant(tenantId, req.params.id);
      if (!ok) return reply.code(404).send({ error: 'Attachment not found' });
      const result = await query<{ storage_path: string }>(
        `DELETE FROM attachments WHERE id = $1 RETURNING storage_path`,
        [req.params.id],
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Attachment not found' });
      }
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
  | (AttachmentRow & { storage_path: string; encryption_version: number })
  | null
  | 'invalid';

/**
 * Load an attachment row with its on-disk path + encryption version,
 * but only if the attachment's parent transaction belongs to the
 * given tenant. Returns `'invalid'` for malformed ids, `null` for
 * "not found OR belongs to another tenant" (deliberately the same
 * shape so cross-tenant probes can't enumerate by status code).
 */
async function loadScopedAttachment(
  id: string,
  tenantId: string,
): Promise<LoadResult> {
  if (!isUuid(id)) return 'invalid';
  const result = await query<
    AttachmentRow & { storage_path: string; encryption_version: number }
  >(
    `SELECT att.id, att.transaction_id, att.filename, att.mime_type, att.byte_size,
            att.created_at, att.extracted_amount_cents, att.extracted_date,
            att.extracted_merchant, att.ocr_provider, att.ocr_status, att.ocr_note,
            att.storage_path, att.encryption_version
       FROM attachments att
       JOIN transactions t ON t.id = att.transaction_id
       JOIN accounts a ON a.id = t.account_id
      WHERE att.id = $1 AND a.tenant_id = $2`,
    [id, tenantId],
  );
  return result.rows[0] ?? null;
}
