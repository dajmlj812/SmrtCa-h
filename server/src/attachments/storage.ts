import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';
import {
  decryptWithDek,
  encryptWithDek,
  getOrCreateTenantKey,
  unwrapDek,
} from './tenant-keys.js';
import { pool } from '../db/pool.js';

/**
 * On-disk encryption formats:
 *
 *   v0 — plaintext. File predates Phase 5 or
 *        ATTACHMENT_ENCRYPTION_KEY was unset at write time.
 *
 *   v1 — encrypted directly with the KEK
 *        (ATTACHMENT_ENCRYPTION_KEY env var). Layout:
 *
 *          [ 12 bytes random IV ][ ciphertext ][ 16 bytes GCM auth tag ]
 *
 *        A leaked KEK exposes every tenant's attachments — this
 *        is the model from 0.16.3 and before.
 *
 *   v2 — 0.16.4 envelope encryption. Per-tenant DEK (data
 *        encryption key, also 256-bit) encrypts the file; the
 *        KEK wraps the DEK in `tenant_encryption_keys`. Layout
 *        on disk is the same as v1 but the key in the cipher
 *        is per-tenant. The DB column `key_generation` records
 *        which generation of the tenant's DEK did the
 *        encrypting (rotation bumps that).
 *
 * The DB column `attachments.encryption_version` is the source
 * of truth on read — never trust the file's contents to tell
 * you which format it's in.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENC_ALGORITHM = 'aes-256-gcm';

export type EncryptionVersion = 0 | 1 | 2;

/**
 * Filesystem-backed attachment storage. Files are written under
 * `config.attachmentsDir` in a `YYYY/MM/<id>-<safeFilename>` layout. The
 * storage path is generated server-side from a UUID and a sanitized
 * filename, never trusted from the user — so the upload route is immune to
 * path-traversal via the filename header.
 */

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Per-request aggregate cap. `@fastify/multipart` already enforces a
 * per-file limit, but `files: 10` × 25 MB allows a 250 MB request that
 * we want to refuse before doing any disk I/O. Override via
 * `ATTACHMENTS_MAX_REQUEST_BYTES` (used by tests to exercise the cap).
 */
export const MAX_REQUEST_BYTES = (() => {
  const raw = process.env.ATTACHMENTS_MAX_REQUEST_BYTES;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 100 * 1024 * 1024;
})();

export class AttachmentValidationError extends Error {}

/** Strip directory components and unsafe characters; cap length. */
export function sanitizeFilename(name: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200);
  // Avoid empty / dot-only names that filesystems hate.
  if (cleaned === '' || /^\.+$/.test(cleaned)) return 'file';
  return cleaned;
}

export function validateMimeType(mime: string): void {
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw new AttachmentValidationError(
      `Unsupported file type "${mime}". Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}.`,
    );
  }
}

export function validateSize(bytes: number): void {
  if (bytes > MAX_FILE_BYTES) {
    throw new AttachmentValidationError(
      `File too large (${bytes} bytes). Maximum is ${MAX_FILE_BYTES} bytes (25 MB).`,
    );
  }
  if (bytes === 0) {
    throw new AttachmentValidationError('Empty file rejected.');
  }
}

function pathForAttachment(attachmentId: string, safeFilename: string): string {
  const now = new Date();
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return join(config.attachmentsDir, y, m, `${attachmentId}-${safeFilename}`);
}

/** Defense in depth — never read/delete a path outside the configured root. */
function assertWithinRoot(storagePath: string): void {
  const root = resolve(config.attachmentsDir);
  const candidate = resolve(storagePath);
  if (!candidate.startsWith(root)) {
    throw new Error(`Refusing to access path outside attachments root: ${storagePath}`);
  }
}

export interface StoredAttachmentInfo {
  storagePath: string;
  /** Length of the PLAINTEXT, regardless of whether the file on disk is encrypted. */
  byteSize: number;
  safeFilename: string;
  /**
   * 0 = plaintext (KEK not configured), 1 = legacy global-KEK
   * encryption (pre-0.16.4), 2 = per-tenant envelope encryption
   * (0.16.4+). New writes are 2 whenever the KEK is configured.
   */
  encryptionVersion: EncryptionVersion;
  /**
   * 0.16.4 — for v2 writes, the generation of the tenant's DEK
   * that did the encrypting. null for v0/v1.
   */
  keyGeneration: number | null;
}

function encryptBuffer(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENC_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

function decryptBuffer(key: Buffer, payload: Buffer): Buffer {
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Attachment ciphertext is shorter than IV + tag');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  const decipher = createDecipheriv(ENC_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Validate, encrypt-if-key-configured, write to disk. The caller is
 * responsible for inserting the database row (so the row + file are
 * written in the same logical step) AND for persisting the returned
 * `encryptionVersion` + `keyGeneration` on the row.
 *
 * 0.16.4 — takes `tenantId` so the encryption can use the
 * tenant's DEK. When the KEK is unset we still fall back to v0
 * plaintext (no per-tenant DEK either, since the DEK can't be
 * wrapped without a KEK).
 */
export async function storeAttachment(
  attachmentId: string,
  tenantId: string,
  filename: string,
  mimeType: string,
  buffer: Buffer,
): Promise<StoredAttachmentInfo> {
  validateMimeType(mimeType);
  validateSize(buffer.byteLength);
  const safeFilename = sanitizeFilename(filename);
  const storagePath = pathForAttachment(attachmentId, safeFilename);
  await mkdir(dirname(storagePath), { recursive: true });

  const kek = config.attachmentEncryptionKey;
  let onDisk: Buffer;
  let encryptionVersion: EncryptionVersion;
  let keyGeneration: number | null;
  if (kek) {
    const tk = await getOrCreateTenantKey(tenantId);
    onDisk = encryptWithDek(tk.dek, buffer);
    encryptionVersion = 2;
    keyGeneration = tk.generation;
  } else {
    onDisk = buffer;
    encryptionVersion = 0;
    keyGeneration = null;
  }
  await writeFile(storagePath, onDisk);

  return {
    storagePath,
    byteSize: buffer.byteLength,
    safeFilename,
    encryptionVersion,
    keyGeneration,
  };
}

/**
 * Read an attachment from disk, decrypting it when the row says
 * it's encrypted. The encryption version lives on the DB row —
 * never trust the file alone (a v1/v2 file with no key is
 * unrecoverable).
 *
 * 0.16.4 — accepts an optional `tenantId` so v2 reads can fetch
 * the right per-tenant DEK. v0/v1 reads ignore it (back-compat
 * with code that hasn't been updated to pass it).
 */
export async function readAttachmentBuffer(
  storagePath: string,
  encryptionVersion: EncryptionVersion = 0,
  tenantId?: string,
): Promise<Buffer> {
  assertWithinRoot(storagePath);
  const raw = await readFile(storagePath);
  if (encryptionVersion === 0) return raw;
  const kek = config.attachmentEncryptionKey;
  if (!kek) {
    throw new Error(
      'Attachment is encrypted but ATTACHMENT_ENCRYPTION_KEY is not configured',
    );
  }
  if (encryptionVersion === 1) {
    return decryptBuffer(kek, raw);
  }
  // v2 — per-tenant envelope encryption.
  if (!tenantId) {
    throw new Error(
      'Reading a v2 attachment requires the tenant id (envelope encryption)',
    );
  }
  const keyRow = await pool.query<{ wrapped_dek: Buffer }>(
    `SELECT wrapped_dek FROM tenant_encryption_keys WHERE tenant_id = $1`,
    [tenantId],
  );
  if (keyRow.rowCount === 0) {
    throw new Error(
      `tenant ${tenantId} has a v2 attachment but no tenant_encryption_keys row`,
    );
  }
  const dek = unwrapDek(keyRow.rows[0]!.wrapped_dek);
  return decryptWithDek(dek, raw);
}

export async function deleteAttachmentFile(storagePath: string): Promise<void> {
  assertWithinRoot(storagePath);
  try {
    await unlink(storagePath);
  } catch (err) {
    // Tolerate the file already being gone — the DB row is the truth.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
