import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';

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
  byteSize: number;
  safeFilename: string;
}

/**
 * Validate, write to disk, return the resolved storage path. The caller is
 * responsible for inserting the database row (so the row + file are written
 * in the same logical step).
 */
export async function storeAttachment(
  attachmentId: string,
  filename: string,
  mimeType: string,
  buffer: Buffer,
): Promise<StoredAttachmentInfo> {
  validateMimeType(mimeType);
  validateSize(buffer.byteLength);
  const safeFilename = sanitizeFilename(filename);
  const storagePath = pathForAttachment(attachmentId, safeFilename);
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, buffer);
  return { storagePath, byteSize: buffer.byteLength, safeFilename };
}

export async function readAttachmentBuffer(storagePath: string): Promise<Buffer> {
  assertWithinRoot(storagePath);
  return readFile(storagePath);
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
