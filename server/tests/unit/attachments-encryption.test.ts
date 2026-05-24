import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../../src/config.js';
import { pool } from '../../src/db/pool.js';
import {
  readAttachmentBuffer,
  storeAttachment,
} from '../../src/attachments/storage.js';
import {
  encryptWithDek,
  rotateTenantKey,
} from '../../src/attachments/tenant-keys.js';
import { resetDb } from '../setup/test-db.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function defaultTenantId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
  );
  return r.rows[0]!.id;
}

async function seedExtraTenant(slug: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
    [slug.replace(/-/g, ' '), slug],
  );
  return r.rows[0]!.id;
}

describe('attachment encryption at rest', () => {
  beforeEach(async () => {
    await resetDb();
    await rm(config.attachmentsDir, { recursive: true, force: true });
  });

  // ── 0.16.4: envelope-encrypted (v2) writes ─────────────────

  it('writes v2 ciphertext + records key_generation when KEK is configured', async () => {
    const tenantId = await defaultTenantId();
    const id = randomUUID();
    const info = await storeAttachment(id, tenantId, 'receipt.png', 'image/png', TINY_PNG);
    expect(info.encryptionVersion).toBe(2);
    expect(info.keyGeneration).toBe(1);

    // The bytes on disk should not equal the plaintext.
    const raw = await readFile(info.storagePath);
    expect(raw.equals(TINY_PNG)).toBe(false);
    // GCM appends a 16-byte tag and prepends a 12-byte IV; total
    // overhead matches the v1 format on the disk side.
    expect(raw.length).toBe(TINY_PNG.length + 12 + 16);

    // A tenant_encryption_keys row was minted.
    const k = await pool.query<{ generation: number; wrapped_dek: Buffer }>(
      `SELECT generation, wrapped_dek FROM tenant_encryption_keys WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(k.rowCount).toBe(1);
    expect(k.rows[0]!.generation).toBe(1);
    // Wrapped DEK is 12 (IV) + 32 (DEK) + 16 (tag) = 60 bytes.
    expect(k.rows[0]!.wrapped_dek.length).toBe(60);
  });

  it('round-trips through readAttachmentBuffer with v=2 + tenantId', async () => {
    const tenantId = await defaultTenantId();
    const id = randomUUID();
    const info = await storeAttachment(id, tenantId, 'receipt.png', 'image/png', TINY_PNG);
    const back = await readAttachmentBuffer(info.storagePath, 2, tenantId);
    expect(back.equals(TINY_PNG)).toBe(true);
  });

  it("tenant A's attachment cannot be decrypted as tenant B", async () => {
    const tenantA = await defaultTenantId();
    const tenantB = await seedExtraTenant('other');
    const id = randomUUID();
    const info = await storeAttachment(id, tenantA, 'receipt.png', 'image/png', TINY_PNG);

    // Both tenants need a key row to even attempt the path.
    // Mint one for B by storing a throwaway file.
    await storeAttachment(randomUUID(), tenantB, 'b.png', 'image/png', TINY_PNG);

    // Reading A's file claiming tenant B should fail GCM
    // authentication (different DEK).
    await expect(readAttachmentBuffer(info.storagePath, 2, tenantB)).rejects.toThrow();
  });

  it('reads pre-Phase-5 v=0 plaintext files unchanged', async () => {
    // Files that pre-date encryption. tenantId is irrelevant.
    const id = randomUUID();
    const dir = join(config.attachmentsDir, 'plain');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}-receipt.png`);
    await writeFile(path, TINY_PNG);
    const back = await readAttachmentBuffer(path, 0);
    expect(back.equals(TINY_PNG)).toBe(true);
  });

  it('reads legacy v=1 (KEK-direct) files using the global KEK', async () => {
    // Simulate a pre-0.16.4 attachment: encrypted directly with
    // the KEK, no tenant_encryption_keys row.
    const id = randomUUID();
    const dir = join(config.attachmentsDir, 'v1');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}-receipt.png`);
    const encrypted = encryptWithDek(config.attachmentEncryptionKey!, TINY_PNG);
    await writeFile(path, encrypted);
    // No tenantId needed for v1 — falls through to the legacy path.
    const back = await readAttachmentBuffer(path, 1);
    expect(back.equals(TINY_PNG)).toBe(true);
  });

  it('reading v=2 with the wrong tenant key fails authentication', async () => {
    const tenantId = await defaultTenantId();
    const id = randomUUID();
    const info = await storeAttachment(id, tenantId, 'receipt.png', 'image/png', TINY_PNG);

    // Corrupt the wrapped DEK so GCM rejects on unwrap. We do
    // this by replacing the row with a freshly-wrapped random
    // DEK — the file on disk is still encrypted with the
    // ORIGINAL DEK, but the DB now points at a different one.
    const replacement = randomBytes(60); // random bytes won't decrypt as a valid DEK
    await pool.query(
      `UPDATE tenant_encryption_keys SET wrapped_dek = $1 WHERE tenant_id = $2`,
      [replacement, tenantId],
    );
    await expect(
      readAttachmentBuffer(info.storagePath, 2, tenantId),
    ).rejects.toThrow();
  });

  // ── 0.16.4: rotation re-encrypts in place ─────────────────

  it('rotateTenantKey rewrites every attachment + bumps generation', async () => {
    const tenantId = await defaultTenantId();
    // Write two attachments at generation 1.
    const a = await storeAttachment(randomUUID(), tenantId, 'a.png', 'image/png', TINY_PNG);
    const b = await storeAttachment(randomUUID(), tenantId, 'b.png', 'image/png', TINY_PNG);
    // Need DB rows for rotation to find them.
    await pool.query(
      `INSERT INTO accounts (id, tenant_id, name, type, currency, opening_balance_cents)
       VALUES (gen_random_uuid(), $1, 'A', 'checking', 'USD', 0) RETURNING id`,
      [tenantId],
    );
    const acct = await pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    const txn = await pool.query<{ id: string }>(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash, normalized_merchant)
       VALUES ($1, '2026-05-01', -100, 'X', $2, 'X') RETURNING id`,
      [acct.rows[0]!.id, randomUUID()],
    );
    for (const att of [a, b]) {
      await pool.query(
        `INSERT INTO attachments
           (id, tenant_id, transaction_id, filename, mime_type, byte_size,
            storage_path, encryption_version, key_generation)
         VALUES (gen_random_uuid(), $1, $2, $3, 'image/png', $4, $5, 2, 1)`,
        [tenantId, txn.rows[0]!.id, att.safeFilename, att.byteSize, att.storagePath],
      );
    }

    const r = await rotateTenantKey(tenantId);
    expect(r.new_generation).toBe(2);
    expect(r.attachments_rewritten).toBe(2);

    // Generation column on attachments is bumped + read still works.
    const rows = await pool.query<{
      key_generation: number;
      storage_path: string;
    }>(
      `SELECT key_generation, storage_path FROM attachments WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows.rowCount).toBe(2);
    for (const row of rows.rows) {
      expect(row.key_generation).toBe(2);
      const back = await readAttachmentBuffer(row.storage_path, 2, tenantId);
      expect(back.equals(TINY_PNG)).toBe(true);
    }
  });

  it('rotateTenantKey upgrades legacy v=1 attachments to v=2', async () => {
    const tenantId = await defaultTenantId();
    // Plant a v1 row on disk + in DB.
    const dir = join(config.attachmentsDir, 'legacy');
    await mkdir(dir, { recursive: true });
    const storagePath = join(dir, `${randomUUID()}-legacy.png`);
    await writeFile(
      storagePath,
      encryptWithDek(config.attachmentEncryptionKey!, TINY_PNG),
    );
    // Need a fake txn for the FK.
    await pool.query(
      `INSERT INTO accounts (id, tenant_id, name, type, currency, opening_balance_cents)
       VALUES (gen_random_uuid(), $1, 'A', 'checking', 'USD', 0)`,
      [tenantId],
    );
    const acct = await pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    const txn = await pool.query<{ id: string }>(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash, normalized_merchant)
       VALUES ($1, '2026-05-01', -100, 'X', $2, 'X') RETURNING id`,
      [acct.rows[0]!.id, randomUUID()],
    );
    await pool.query(
      `INSERT INTO attachments
         (id, tenant_id, transaction_id, filename, mime_type, byte_size,
          storage_path, encryption_version, key_generation)
       VALUES (gen_random_uuid(), $1, $2, 'legacy.png', 'image/png', $3, $4, 1, NULL)`,
      [tenantId, txn.rows[0]!.id, TINY_PNG.length, storagePath],
    );

    const r = await rotateTenantKey(tenantId);
    expect(r.attachments_rewritten).toBe(1);

    const row = await pool.query<{ encryption_version: number; key_generation: number }>(
      `SELECT encryption_version, key_generation FROM attachments WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(row.rows[0]!.encryption_version).toBe(2);
    expect(row.rows[0]!.key_generation).toBe(1); // first generation for this tenant
    // And the file is now readable via the v2 path.
    const back = await readAttachmentBuffer(storagePath, 2, tenantId);
    expect(back.equals(TINY_PNG)).toBe(true);
  });
});
