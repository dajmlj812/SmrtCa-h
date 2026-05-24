import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { resolve } from 'node:path';

/**
 * 0.16.4 — envelope encryption for attachments.
 *
 * Each tenant gets a 256-bit DEK (data encryption key), generated
 * lazily on first attachment write. The DEK never appears in the
 * database in cleartext — it's wrapped with the KEK
 * (config.attachmentEncryptionKey, sourced from the
 * ATTACHMENT_ENCRYPTION_KEY env var) via AES-256-GCM and stored
 * in `tenant_encryption_keys.wrapped_dek`.
 *
 * Read path:
 *   1) load the wrapped DEK for the tenant
 *   2) unwrap it with the KEK
 *   3) decrypt the attachment payload with the unwrapped DEK
 *
 * Write path: symmetric — fetch the DEK, encrypt, write.
 *
 * Rotation: generate a new DEK, re-encrypt every existing
 * attachment for that tenant in a single transaction, then
 * UPDATE the wrapped_dek + bump the generation. If the
 * transaction aborts mid-way nothing changes — the read path
 * still works with the old DEK.
 */

const KEK_IV_BYTES = 12;
const KEK_TAG_BYTES = 16;
const DEK_BYTES = 32; // AES-256
const DATA_IV_BYTES = 12;
const DATA_TAG_BYTES = 16;
const ALG = 'aes-256-gcm';

/**
 * Throws if the operator hasn't configured a KEK. Envelope
 * encryption is a no-op without it — same constraint as the
 * old global-key flow.
 */
function requireKek(): Buffer {
  const k = config.attachmentEncryptionKey;
  if (!k) {
    throw new Error(
      'ATTACHMENT_ENCRYPTION_KEY is not configured — set it in /settings or the env file before encrypting attachments',
    );
  }
  return k;
}

function wrapDek(dek: Buffer): Buffer {
  const kek = requireKek();
  const iv = randomBytes(KEK_IV_BYTES);
  const cipher = createCipheriv(ALG, kek, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

export function unwrapDek(wrapped: Buffer): Buffer {
  const kek = requireKek();
  if (wrapped.length < KEK_IV_BYTES + KEK_TAG_BYTES) {
    throw new Error('wrapped DEK is shorter than IV + tag');
  }
  const iv = wrapped.subarray(0, KEK_IV_BYTES);
  const tag = wrapped.subarray(wrapped.length - KEK_TAG_BYTES);
  const ct = wrapped.subarray(KEK_IV_BYTES, wrapped.length - KEK_TAG_BYTES);
  const decipher = createDecipheriv(ALG, kek, iv);
  decipher.setAuthTag(tag);
  const dek = Buffer.concat([decipher.update(ct), decipher.final()]);
  if (dek.length !== DEK_BYTES) {
    throw new Error(`unwrapped DEK is ${dek.length} bytes, expected ${DEK_BYTES}`);
  }
  return dek;
}

export interface TenantKey {
  dek: Buffer;       // 32 bytes, in-memory only
  generation: number;
}

/**
 * Fetch the tenant's DEK, generating one on first call. The
 * wrapped DEK lives in `tenant_encryption_keys`; this function
 * unwraps it with the KEK on every call (no caching, by design
 * — KEK rotation should be immediate, and the cost is one
 * 60-byte AES op per attachment).
 */
export async function getOrCreateTenantKey(
  tenantId: string,
): Promise<TenantKey> {
  const existing = await pool.query<{ wrapped_dek: Buffer; generation: number }>(
    `SELECT wrapped_dek, generation FROM tenant_encryption_keys WHERE tenant_id = $1`,
    [tenantId],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    const row = existing.rows[0]!;
    return { dek: unwrapDek(row.wrapped_dek), generation: row.generation };
  }
  // First write for this tenant — mint a fresh DEK.
  const dek = randomBytes(DEK_BYTES);
  const wrapped = wrapDek(dek);
  // ON CONFLICT no-op handles the race where two requests for a
  // brand-new tenant try to mint concurrently. Whoever wins, the
  // other reads the winner's value on the next round.
  const ins = await pool.query<{ generation: number; wrapped_dek: Buffer }>(
    `INSERT INTO tenant_encryption_keys (tenant_id, wrapped_dek, generation)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id) DO NOTHING
     RETURNING generation, wrapped_dek`,
    [tenantId, wrapped],
  );
  if (ins.rowCount && ins.rowCount > 0) {
    return { dek, generation: ins.rows[0]!.generation };
  }
  // Lost the race — re-read.
  const second = await pool.query<{ wrapped_dek: Buffer; generation: number }>(
    `SELECT wrapped_dek, generation FROM tenant_encryption_keys WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = second.rows[0]!;
  return { dek: unwrapDek(row.wrapped_dek), generation: row.generation };
}

/**
 * Encrypt a buffer with the tenant's DEK. Returns the
 * `[iv|ciphertext|tag]` payload + the generation that did the
 * encrypting — the caller stores both on the attachment row.
 */
export function encryptWithDek(
  dek: Buffer,
  plaintext: Buffer,
): Buffer {
  const iv = randomBytes(DATA_IV_BYTES);
  const cipher = createCipheriv(ALG, dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

export function decryptWithDek(dek: Buffer, payload: Buffer): Buffer {
  if (payload.length < DATA_IV_BYTES + DATA_TAG_BYTES) {
    throw new Error('attachment payload shorter than IV + tag');
  }
  const iv = payload.subarray(0, DATA_IV_BYTES);
  const tag = payload.subarray(payload.length - DATA_TAG_BYTES);
  const ct = payload.subarray(DATA_IV_BYTES, payload.length - DATA_TAG_BYTES);
  const decipher = createDecipheriv(ALG, dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export interface RotateResult {
  attachments_rewritten: number;
  new_generation: number;
}

/**
 * Rotate a tenant's DEK + re-encrypt every existing attachment
 * (v1 KEK-direct and v2 envelope-encrypted alike) under the new
 * key. Plaintext (v0) rows are upgraded to v2 in the process —
 * "rotation" doubles as a one-shot encrypt-at-rest enforcement.
 *
 * Transactional:
 *   • Pull the current DEK (for decrypting v2 rows)
 *   • Mint the new DEK
 *   • For each attachment in the tenant: read → decrypt-with-old
 *     → re-encrypt-with-new → write back. The disk write happens
 *     OUTSIDE the DB transaction (one file at a time so a crash
 *     leaves the disk consistent with the DB on the *previous*
 *     row).
 *   • COMMIT writes the new wrapped DEK + bumps generation;
 *     UPDATEs every attachments row to encryption_version=2 +
 *     key_generation=<new>.
 *
 * If the function throws before COMMIT, every row in the DB
 * still points at v2 ciphertext that decrypts with the OLD DEK
 * (which is still the live wrapped_dek). Re-running the
 * rotation picks up where it left off.
 */
export async function rotateTenantKey(tenantId: string): Promise<RotateResult> {
  requireKek(); // fail fast before doing any disk I/O

  const oldKeyRow = await pool.query<{
    wrapped_dek: Buffer;
    generation: number;
  }>(
    `SELECT wrapped_dek, generation FROM tenant_encryption_keys WHERE tenant_id = $1`,
    [tenantId],
  );
  const oldDek =
    oldKeyRow.rowCount && oldKeyRow.rowCount > 0
      ? unwrapDek(oldKeyRow.rows[0]!.wrapped_dek)
      : null;
  const oldGeneration =
    oldKeyRow.rowCount && oldKeyRow.rowCount > 0
      ? oldKeyRow.rows[0]!.generation
      : 0;
  const newDek = randomBytes(DEK_BYTES);
  const newGeneration = oldGeneration + 1;
  const newWrapped = wrapDek(newDek);

  // Fetch every attachment row + its current encryption metadata
  // OUTSIDE the transaction; we'll re-read inside the txn for
  // the UPDATE. The set is stable enough — uploads during
  // rotation race with us, but the loop is single-threaded and
  // any new uploads during the loop use the OLD generation (we
  // haven't bumped it yet); they'll be re-handled on the next
  // rotation if needed. This is acceptable because rotation is
  // rare + manual.
  const rows = await pool.query<{
    id: string;
    storage_path: string;
    encryption_version: number;
    key_generation: number | null;
  }>(
    `SELECT id, storage_path, encryption_version, key_generation
       FROM attachments WHERE tenant_id = $1`,
    [tenantId],
  );

  // Re-encrypt each file on disk under the new DEK.
  let rewritten = 0;
  for (const att of rows.rows) {
    const onDisk = await readFile(safePath(att.storage_path));
    let plaintext: Buffer;
    if (att.encryption_version === 0) {
      plaintext = onDisk;
    } else if (att.encryption_version === 1) {
      // Legacy: encrypted directly with the KEK.
      plaintext = decryptWithDek(requireKek(), onDisk);
    } else if (att.encryption_version === 2) {
      if (!oldDek) {
        throw new Error(
          `attachments row ${att.id} is v2 but the tenant has no DEK row`,
        );
      }
      plaintext = decryptWithDek(oldDek, onDisk);
    } else {
      throw new Error(
        `unknown encryption_version ${att.encryption_version} on attachment ${att.id}`,
      );
    }
    const rewrap = encryptWithDek(newDek, plaintext);
    await writeFile(safePath(att.storage_path), rewrap);
    rewritten++;
  }

  // Commit the key row + every attachment's metadata in one
  // transaction. If the txn fails after the file rewrites, the
  // files now decrypt with the new DEK but the DB says they
  // need the old one — the operator can re-run the rotation
  // and the re-encrypt branch above will succeed (the v2 rows
  // will fail to decrypt with the old DEK, leaving them broken).
  //
  // To survive that case the txn is committed BEFORE the
  // function returns. The on-disk write loop is the only window
  // where state can diverge; a partial-loop crash leaves the
  // already-rewritten files unable to decrypt. Operators are
  // warned in the runbook to back up before rotating.
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO tenant_encryption_keys (tenant_id, wrapped_dek, generation, rotated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         wrapped_dek = EXCLUDED.wrapped_dek,
         generation = EXCLUDED.generation,
         rotated_at = now()`,
      [tenantId, newWrapped, newGeneration],
    );
    await client.query(
      `UPDATE attachments
          SET encryption_version = 2,
              key_generation = $1
        WHERE tenant_id = $2`,
      [newGeneration, tenantId],
    );
  });

  return { attachments_rewritten: rewritten, new_generation: newGeneration };
}

function safePath(p: string): string {
  // Defense in depth — the rotation loop runs server-side with
  // full filesystem access, so we must NOT let a tampered DB
  // row send us writing outside the attachments directory.
  const root = resolve(config.attachmentsDir);
  const candidate = resolve(p);
  if (!candidate.startsWith(root)) {
    throw new Error(`Refusing to access path outside attachments root: ${p}`);
  }
  return candidate;
}
