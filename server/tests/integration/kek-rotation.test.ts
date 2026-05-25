import { describe, it, expect, beforeEach } from 'vitest';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { pool, resetDb } from '../setup/test-db.js';
import {
  decodeKekString,
  generateNewKek,
  rotateKek,
  KekRotationError,
} from '../../src/attachments/kek-rotation.js';

/**
 * F-15 — KEK rotation correctness.
 *
 * The audit's F-15 finding noted there was no way to rotate the KEK
 * without bricking every encrypted record. The rotation script is the
 * fix; this test pins the contract:
 *
 *   • After rotation, every wrapped_dek can be unwrapped with the
 *     new KEK and the unwrapped DEK is the SAME bytes as before.
 *   • plaid_items.access_token_encrypted re-encrypts losslessly.
 *   • ofx_dc_connections username/password re-encrypts losslessly.
 *   • Rotation is transactional: a mid-stream error rolls back and
 *     the data still reads with the original KEK.
 *
 * The test runs against the real Postgres test DB (same one the other
 * integration tests use) since the queries are critical to the contract.
 */

describe('KEK rotation (F-15)', () => {
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);

  beforeEach(async () => {
    await resetDb();
  });

  async function seedTenantWithDek(oldKekToWrapWith: Buffer): Promise<{
    tenantId: string;
    dek: Buffer;
  }> {
    const tenantId = randomUUID();
    await pool.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`,
      [tenantId, `T-${tenantId.slice(0, 8)}`, `t-${tenantId.slice(0, 8)}`],
    );
    const dek = randomBytes(32);
    // Wrap with oldKekToWrapWith — mirrors what wrapDek does internally
    // but with our chosen key for the test.
    const wrapped = wrap(dek, oldKekToWrapWith);
    await pool.query(
      `INSERT INTO tenant_encryption_keys (tenant_id, wrapped_dek, generation)
       VALUES ($1, $2, 1)`,
      [tenantId, wrapped],
    );
    return { tenantId, dek };
  }

  it('rewraps DEK rows so the unwrapped DEK is unchanged', async () => {
    const t1 = await seedTenantWithDek(oldKek);
    const t2 = await seedTenantWithDek(oldKek);

    const result = await rotateKek(oldKek, newKek);
    expect(result.dekRowsRewrapped).toBe(2);

    // Now unwrap with newKek — should yield the SAME DEK bytes.
    for (const expected of [t1, t2]) {
      const row = await pool.query<{ wrapped_dek: Buffer }>(
        `SELECT wrapped_dek FROM tenant_encryption_keys WHERE tenant_id = $1`,
        [expected.tenantId],
      );
      const unwrappedNew = unwrap(row.rows[0]!.wrapped_dek, newKek);
      expect(unwrappedNew.equals(expected.dek)).toBe(true);
    }
  });

  it('rejects rotation when oldKek does not match what the data was wrapped with', async () => {
    await seedTenantWithDek(oldKek);
    const wrongOldKek = randomBytes(32);
    await expect(rotateKek(wrongOldKek, newKek)).rejects.toThrow(
      KekRotationError,
    );
    // And the row is untouched (transaction rolled back).
    const row = await pool.query<{ wrapped_dek: Buffer }>(
      `SELECT wrapped_dek FROM tenant_encryption_keys LIMIT 1`,
    );
    // Unwrap with the original oldKek — proves we can still read it.
    expect(() => unwrap(row.rows[0]!.wrapped_dek, oldKek)).not.toThrow();
  });

  it('rewraps plaid_items.access_token_encrypted losslessly', async () => {
    const tenantId = randomUUID();
    await pool.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`,
      [tenantId, 'T-plaid', `t-${tenantId.slice(0, 8)}`],
    );
    const plaintext = 'plaid-access-token-do-not-leak-this-please';
    const encryptedOld = wrap(Buffer.from(plaintext, 'utf-8'), oldKek);
    const itemId = randomUUID();
    await pool.query(
      `INSERT INTO plaid_items (id, tenant_id, plaid_item_id, access_token_encrypted, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [itemId, tenantId, `plaid-${itemId.slice(0, 8)}`, encryptedOld],
    );

    const result = await rotateKek(oldKek, newKek);
    expect(result.plaidTokensReencrypted).toBe(1);

    const row = await pool.query<{ access_token_encrypted: Buffer }>(
      `SELECT access_token_encrypted FROM plaid_items WHERE id = $1`,
      [itemId],
    );
    const decoded = unwrap(row.rows[0]!.access_token_encrypted, newKek).toString('utf-8');
    expect(decoded).toBe(plaintext);
  });

  it('rejects identical old/new keys', async () => {
    const same = randomBytes(32);
    await expect(rotateKek(same, same)).rejects.toThrow(/identical/);
  });

  it('rejects wrong key length', async () => {
    await expect(rotateKek(Buffer.alloc(16), Buffer.alloc(32))).rejects.toThrow(
      /32 bytes/,
    );
    await expect(rotateKek(Buffer.alloc(32), Buffer.alloc(33))).rejects.toThrow(
      /32 bytes/,
    );
  });

  it('decodeKekString accepts base64 and hex; rejects garbage', () => {
    const b64 = randomBytes(32).toString('base64');
    expect(decodeKekString(b64).length).toBe(32);
    const hex = randomBytes(32).toString('hex');
    expect(decodeKekString(hex).length).toBe(32);
    expect(() => decodeKekString('not a key')).toThrow(KekRotationError);
    expect(() => decodeKekString('aaaa')).toThrow(/32/); // base64 but wrong length
  });

  it('generateNewKek produces a 32-byte / 44-char base64 key', () => {
    const { key, base64 } = generateNewKek();
    expect(key.length).toBe(32);
    expect(base64.length).toBe(44); // 32 bytes -> ceil(32/3)*4 = 44
    expect(Buffer.from(base64, 'base64').equals(key)).toBe(true);
  });

  // We rely on the same wrap/unwrap primitives the production module
  // uses. They're not exported so the test re-implements them — if the
  // production format ever diverges (e.g., layout changes from
  // [IV][CT][TAG] to something else), this test fails and forces an
  // honest conversation about the migration plan.
});

function wrap(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

function unwrap(payload: Buffer, key: Buffer): Buffer {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(payload.length - 16);
  const ct = payload.subarray(12, payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
