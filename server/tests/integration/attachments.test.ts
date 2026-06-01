import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import FormData from 'form-data';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  cleanupAttachmentDir,
  makeTestApp,
  pool,
  resetDb,
  seedAccount,
} from '../setup/test-db.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const TINY_PDF = Buffer.from('%PDF-1.4\n%PDF stub for tests\n%EOF');

function buildAttachmentForm(
  files: Array<{ name: string; mime: string; buffer: Buffer }>,
): FormData {
  const form = new FormData();
  for (const f of files) {
    form.append('file', f.buffer, {
      filename: f.name,
      contentType: f.mime,
    });
  }
  return form;
}

async function seedTxn(accountId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash)
     VALUES ($1, '2026-05-01', -1234, 'COFFEE SHOP', $2)
     RETURNING id`,
    [accountId, randomUUID()],
  );
  return result.rows[0]!.id;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

describe('Attachments API', () => {
  let app: FastifyInstance;
  let accountId: string;
  let txnId: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    await cleanupAttachmentDir();
    accountId = await seedAccount();
    txnId = await seedTxn(accountId);
  });

  it('uploads a PNG, inserts the row, writes the file, marks OCR skipped (no provider)', async () => {
    const form = buildAttachmentForm([
      { name: 'receipt.png', mime: 'image/png', buffer: TINY_PNG },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txnId}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(201);

    const { attachments } = res.json();
    expect(attachments).toHaveLength(1);
    const att = attachments[0];
    expect(att.filename).toBe('receipt.png');
    expect(att.mime_type).toBe('image/png');
    expect(att.byte_size).toBe(TINY_PNG.length);
    // No OCR provider in test env (AI_PROVIDER=rules) — so the row is
    // already marked skipped.
    expect(att.ocr_status).toBe('skipped');

    // File landed on disk.
    const row = await pool.query<{ storage_path: string }>(
      'SELECT storage_path FROM attachments WHERE id = $1',
      [att.id],
    );
    expect(existsSync(row.rows[0]!.storage_path)).toBe(true);
  });

  it('accepts multiple files in one request', async () => {
    const form = buildAttachmentForm([
      { name: 'a.png', mime: 'image/png', buffer: TINY_PNG },
      { name: 'b.pdf', mime: 'application/pdf', buffer: TINY_PDF },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txnId}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().attachments).toHaveLength(2);
  });

  it('rejects unsupported MIME types', async () => {
    const form = buildAttachmentForm([
      { name: 'evil.exe', mime: 'application/x-msdownload', buffer: Buffer.from('MZ') },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txnId}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unsupported file type/);
  });

  it('rejects empty files', async () => {
    const form = buildAttachmentForm([
      { name: 'empty.png', mime: 'image/png', buffer: Buffer.alloc(0) },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txnId}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('sanitizes a path-traversal filename and never escapes the attachments root', async () => {
    const form = buildAttachmentForm([
      { name: '../../etc/passwd.png', mime: 'image/png', buffer: TINY_PNG },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txnId}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(201);
    const att = res.json().attachments[0];
    expect(att.filename).not.toContain('..');
    expect(att.filename).not.toContain('/');
    expect(att.filename).not.toContain('\\');
  });

  it('lists attachments for a transaction', async () => {
    const form = buildAttachmentForm([
      { name: 'r.png', mime: 'image/png', buffer: TINY_PNG },
    ]);
    await app.inject({
      method: 'POST',
      url: `/api/transactions/${txnId}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/transactions/${txnId}/attachments`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().attachments).toHaveLength(1);
  });

  it('returns the file via the download endpoint with the right Content-Type', async () => {
    const form = buildAttachmentForm([
      { name: 'r.png', mime: 'image/png', buffer: TINY_PNG },
    ]);
    const upload = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txnId}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    const att = upload.json().attachments[0];

    const res = await app.inject({
      method: 'GET',
      url: `/api/attachments/${att.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/attachment;/);
    expect(res.rawPayload.length).toBe(TINY_PNG.length);
  });

  it('preview returns the file inline', async () => {
    const form = buildAttachmentForm([
      { name: 'r.png', mime: 'image/png', buffer: TINY_PNG },
    ]);
    const upload = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txnId}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    const att = upload.json().attachments[0];

    const res = await app.inject({
      method: 'GET',
      url: `/api/attachments/${att.id}/preview`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
  });

  it('deletes the row and the file', async () => {
    const form = buildAttachmentForm([
      { name: 'r.png', mime: 'image/png', buffer: TINY_PNG },
    ]);
    const upload = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txnId}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    const att = upload.json().attachments[0];

    const path = (
      await pool.query<{ storage_path: string }>(
        'SELECT storage_path FROM attachments WHERE id = $1',
        [att.id],
      )
    ).rows[0]!.storage_path;
    expect(existsSync(path)).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/attachments/${att.id}`,
    });
    expect(del.statusCode).toBe(204);
    expect(existsSync(path)).toBe(false);

    const after = await pool.query(
      'SELECT id FROM attachments WHERE id = $1',
      [att.id],
    );
    expect(after.rowCount).toBe(0);
  });

  it('returns 400 for a malformed attachment id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the attachment does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/attachments/${ZERO_UUID}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects with 413 when the aggregate upload exceeds the cap', async () => {
    // Vitest config sets ATTACHMENTS_MAX_REQUEST_BYTES=1 MB; two 600 KB
    // files clear the per-file limit but trip the aggregate cap.
    // The buffer must start with the real PNG signature or the F-21
    // magic-byte sniff rejects each file (400) BEFORE the aggregate-cap
    // check (413) can fire. Prefix TINY_PNG, then pad to 600 KB.
    const SIX_HUNDRED_KB = Buffer.concat([
      TINY_PNG,
      Buffer.alloc(600 * 1024 - TINY_PNG.length, 1),
    ]);
    const form = buildAttachmentForm([
      { name: 'a.png', mime: 'image/png', buffer: SIX_HUNDRED_KB },
      { name: 'b.png', mime: 'image/png', buffer: SIX_HUNDRED_KB },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txnId}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/aggregate cap/);

    // Neither file made it to disk or the DB.
    const after = await pool.query(
      'SELECT id FROM attachments WHERE transaction_id = $1',
      [txnId],
    );
    expect(after.rowCount).toBe(0);
  });

  it('returns 404 uploading to a missing transaction', async () => {
    const form = buildAttachmentForm([
      { name: 'r.png', mime: 'image/png', buffer: TINY_PNG },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/transactions/${ZERO_UUID}/attachments`,
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});
