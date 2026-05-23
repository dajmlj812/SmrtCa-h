import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Generic AES-256-GCM helpers for short secrets stored in the
 * database — currently OFX Direct Connect credentials. Same wire
 * format as `attachments/storage.ts` so we never need to choose a
 * different key:
 *
 *   [ 12-byte IV ][ ciphertext ][ 16-byte GCM auth tag ]
 *
 * Reuses ATTACHMENT_ENCRYPTION_KEY: it's effectively the server's
 * "data-at-rest" key. If the operator hasn't configured it, these
 * helpers throw — we refuse to store bank passwords in plaintext.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENC_ALGORITHM = 'aes-256-gcm';

export class CryptoNotConfiguredError extends Error {
  constructor() {
    super(
      'ATTACHMENT_ENCRYPTION_KEY is not set — refusing to store secrets in plaintext',
    );
  }
}

function getKey(): Buffer {
  const key = config.attachmentEncryptionKey;
  if (!key) throw new CryptoNotConfiguredError();
  return key;
}

export function encryptString(plaintext: string): Buffer {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENC_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

export function decryptString(payload: Buffer): string {
  const key = getKey();
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Ciphertext shorter than IV + tag');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  const decipher = createDecipheriv(ENC_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf-8',
  );
}
