import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  cleanupAttachmentDir,
  pool,
  resetDb,
  seedAccount,
} from '../setup/test-db.js';
import {
  markOcrSkipped,
  runOcrExtraction,
} from '../../src/ocr/extract-service.js';
import type { OcrProvider } from '../../src/ocr/types.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function seedAttachment(
  accountId: string,
): Promise<{ txnId: string; attachmentId: string }> {
  const txn = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash)
     VALUES ($1, '2026-05-14', -1234, 'COFFEE SHOP', $2)
     RETURNING id`,
    [accountId, randomUUID()],
  );
  const txnId = txn.rows[0]!.id;
  const att = await pool.query<{ id: string }>(
    `INSERT INTO attachments
       (transaction_id, filename, mime_type, byte_size, storage_path)
     VALUES ($1, 'receipt.png', 'image/png', $2, '/tmp/test-storage-path.png')
     RETURNING id`,
    [txnId, TINY_PNG.length],
  );
  return { txnId, attachmentId: att.rows[0]!.id };
}

const mockOcrSuccess: OcrProvider = {
  id: 'test',
  name: 'Test',
  extract: async () => ({
    amountCents: 1234,
    date: '2026-05-14',
    merchant: 'Coffee Shop',
    confidence: 0.95,
    note: null,
  }),
};

const mockOcrFailure: OcrProvider = {
  id: 'test',
  name: 'Test',
  extract: async () => {
    throw new Error('Simulated OCR failure');
  },
};

describe('OCR pipeline (functional)', () => {
  beforeAll(async () => {
    // The functional test exercises the service against the test DB —
    // no Fastify app or filesystem needed.
  });
  afterAll(async () => undefined);

  beforeEach(async () => {
    await resetDb();
    await cleanupAttachmentDir();
  });

  it('extracts fields and writes them with status="extracted"', async () => {
    const accountId = await seedAccount();
    const { attachmentId } = await seedAttachment(accountId);

    await runOcrExtraction(
      attachmentId,
      mockOcrSuccess,
      TINY_PNG,
      'image/png',
      'receipt.png',
    );

    const row = await pool.query(
      'SELECT * FROM attachments WHERE id = $1',
      [attachmentId],
    );
    const r = row.rows[0]!;
    expect(r.ocr_status).toBe('extracted');
    expect(r.ocr_provider).toBe('test');
    expect(Number(r.extracted_amount_cents)).toBe(1234);
    expect(r.extracted_date).toBe('2026-05-14');
    expect(r.extracted_merchant).toBe('Coffee Shop');
  });

  it('records "failed" status with the error message when extraction throws', async () => {
    const accountId = await seedAccount();
    const { attachmentId } = await seedAttachment(accountId);

    await expect(
      runOcrExtraction(
        attachmentId,
        mockOcrFailure,
        TINY_PNG,
        'image/png',
        'receipt.png',
      ),
    ).rejects.toThrow(/Simulated OCR failure/);

    const row = await pool.query(
      'SELECT * FROM attachments WHERE id = $1',
      [attachmentId],
    );
    expect(row.rows[0]!.ocr_status).toBe('failed');
    expect(row.rows[0]!.ocr_note).toMatch(/Simulated OCR failure/);
  });

  it('markOcrSkipped flips a pending row to skipped', async () => {
    const accountId = await seedAccount();
    const { attachmentId } = await seedAttachment(accountId);

    await markOcrSkipped(attachmentId);

    const row = await pool.query(
      'SELECT ocr_status, ocr_note FROM attachments WHERE id = $1',
      [attachmentId],
    );
    expect(row.rows[0]!.ocr_status).toBe('skipped');
    expect(row.rows[0]!.ocr_note).toBe('No OCR provider configured');
  });
});
