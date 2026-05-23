import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../src/config.js';
import {
  readAttachmentBuffer,
  storeAttachment,
} from '../../src/attachments/storage.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('attachment encryption at rest', () => {
  beforeEach(async () => {
    await rm(config.attachmentsDir, { recursive: true, force: true });
  });

  it('writes v1 ciphertext when ATTACHMENT_ENCRYPTION_KEY is set', async () => {
    const id = randomUUID();
    const info = await storeAttachment(id, 'receipt.png', 'image/png', TINY_PNG);
    expect(info.encryptionVersion).toBe(1);

    // The bytes on disk should not equal the plaintext.
    const raw = await readFile(info.storagePath);
    expect(raw.equals(TINY_PNG)).toBe(false);
    // GCM appends a 16-byte tag and prepends a 12-byte IV.
    expect(raw.length).toBe(TINY_PNG.length + 12 + 16);
  });

  it('round-trips through readAttachmentBuffer with v=1', async () => {
    const id = randomUUID();
    const info = await storeAttachment(id, 'receipt.png', 'image/png', TINY_PNG);
    const back = await readAttachmentBuffer(info.storagePath, 1);
    expect(back.equals(TINY_PNG)).toBe(true);
  });

  it('reads pre-Phase-5 v=0 plaintext files unchanged', async () => {
    // Simulate a file that was uploaded before encryption was enabled.
    const id = randomUUID();
    const dir = join(config.attachmentsDir, 'plain');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}-receipt.png`);
    await writeFile(path, TINY_PNG);
    const back = await readAttachmentBuffer(path, 0);
    expect(back.equals(TINY_PNG)).toBe(true);
  });

  it('reading v=1 with the wrong key fails authentication', async () => {
    const id = randomUUID();
    const info = await storeAttachment(id, 'receipt.png', 'image/png', TINY_PNG);

    // Swap the key for one byte, then try to read. GCM should reject.
    const original = config.attachmentEncryptionKey!;
    const tampered = Buffer.from(original);
    tampered[0] = (tampered[0]! ^ 0xff);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).attachmentEncryptionKey = tampered;
    try {
      await expect(
        readAttachmentBuffer(info.storagePath, 1),
      ).rejects.toThrow();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).attachmentEncryptionKey = original;
    }
  });
});
