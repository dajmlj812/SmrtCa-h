import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { withTransaction } from '../db/pool.js';

/**
 * F-15 (security audit 2026-05-25) — KEK rotation.
 *
 * The KEK (`ATTACHMENT_ENCRYPTION_KEY`) wraps every tenant's DEK in
 * `tenant_encryption_keys.wrapped_dek` and directly encrypts the few
 * "small secret" columns we hold:
 *
 *   • plaid_items.access_token_encrypted
 *   • ofx_dc_connections.username_encrypted / password_encrypted
 *
 * Before this module existed, swapping the KEK without re-wrapping
 * those columns bricked every encrypted record: AES-GCM tag mismatch
 * on next read → "Unsupported state or unable to authenticate data".
 * That's exactly the trap we walked into when rotating the KEK on the
 * test server during the audit.
 *
 * This function takes BOTH keys explicitly (no global state), reads
 * every affected row, decrypts with the old KEK in memory, re-encrypts
 * with the new KEK, and writes back inside one DB transaction. If
 * anything throws, the transaction rolls back and the old KEK is still
 * the correct one to use against the data on disk.
 *
 * The function does NOT touch process.env or the on-disk .env file.
 * The CLI wrapper (`scripts/rotate-kek.mjs`) is responsible for the
 * .env swap, and only does it after this function returns successfully.
 *
 * Design notes:
 *   - We don't use crypto.ts's encryptString / decryptString here
 *     because those helpers read the global config key. A rotation has
 *     two keys in play — the old one (already loaded into config when
 *     the process booted) and the new one (passed in by the operator).
 *     Inline cipher operations keep both available without poking at
 *     module state.
 *   - We deliberately do NOT bump the per-tenant DEK generation. The
 *     DEK material itself is unchanged — we're just changing the
 *     envelope around it. `generation` is the rotateTenantKey()
 *     concept and a KEK rotation should be invisible to readers of
 *     attachment metadata.
 */

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

export interface RotateKekResult {
  dekRowsRewrapped: number;
  plaidTokensReencrypted: number;
  ofxCredsReencrypted: number;
}

export class KekRotationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

/**
 * Rotate the KEK that wraps every tenant DEK and directly encrypts
 * Plaid + OFX-DC credentials.
 *
 * Both keys must be 32-byte Buffers (AES-256). The caller is
 * responsible for validating + decoding the key strings.
 */
export async function rotateKek(
  oldKek: Buffer,
  newKek: Buffer,
): Promise<RotateKekResult> {
  if (oldKek.length !== 32) {
    throw new KekRotationError(
      `oldKek must be 32 bytes (got ${oldKek.length})`,
    );
  }
  if (newKek.length !== 32) {
    throw new KekRotationError(
      `newKek must be 32 bytes (got ${newKek.length})`,
    );
  }
  if (oldKek.equals(newKek)) {
    throw new KekRotationError(
      'oldKek and newKek are identical — refusing no-op rotation',
    );
  }

  return await withTransaction(async (client) => {
    // ── 1) tenant_encryption_keys ────────────────────────────
    // Each row holds a per-tenant 32-byte DEK wrapped by the KEK.
    // Unwrap with old KEK, re-wrap with new KEK.
    const dekRows = await client.query<{ tenant_id: string; wrapped_dek: Buffer }>(
      'SELECT tenant_id, wrapped_dek FROM tenant_encryption_keys',
    );
    let dekRowsRewrapped = 0;
    for (const row of dekRows.rows) {
      const dek = unwrap(row.wrapped_dek, oldKek);
      if (dek.length !== DEK_BYTES) {
        throw new KekRotationError(
          `tenant ${row.tenant_id} DEK has wrong length after unwrap (got ${dek.length}, expected ${DEK_BYTES}) — refusing to continue`,
        );
      }
      const rewrapped = wrap(dek, newKek);
      await client.query(
        'UPDATE tenant_encryption_keys SET wrapped_dek = $1 WHERE tenant_id = $2',
        [rewrapped, row.tenant_id],
      );
      dekRowsRewrapped++;
    }

    // ── 2) plaid_items.access_token_encrypted ────────────────
    // Encrypted directly with KEK via domain/crypto.ts.
    const plaidRows = await client.query<{
      id: string;
      access_token_encrypted: Buffer;
    }>(
      'SELECT id, access_token_encrypted FROM plaid_items WHERE access_token_encrypted IS NOT NULL',
    );
    let plaidTokensReencrypted = 0;
    for (const row of plaidRows.rows) {
      const plaintext = unwrap(row.access_token_encrypted, oldKek);
      const reenc = wrap(plaintext, newKek);
      await client.query(
        'UPDATE plaid_items SET access_token_encrypted = $1 WHERE id = $2',
        [reenc, row.id],
      );
      plaidTokensReencrypted++;
    }

    // ── 3) ofx_dc_connections username_encrypted + password_encrypted ─
    const ofxRows = await client.query<{
      id: string;
      username_encrypted: Buffer | null;
      password_encrypted: Buffer | null;
    }>(
      'SELECT id, username_encrypted, password_encrypted FROM ofx_dc_connections',
    );
    let ofxCredsReencrypted = 0;
    for (const row of ofxRows.rows) {
      const newUser =
        row.username_encrypted !== null
          ? wrap(unwrap(row.username_encrypted, oldKek), newKek)
          : null;
      const newPass =
        row.password_encrypted !== null
          ? wrap(unwrap(row.password_encrypted, oldKek), newKek)
          : null;
      await client.query(
        'UPDATE ofx_dc_connections SET username_encrypted = $1, password_encrypted = $2 WHERE id = $3',
        [newUser, newPass, row.id],
      );
      ofxCredsReencrypted++;
    }

    return { dekRowsRewrapped, plaidTokensReencrypted, ofxCredsReencrypted };
  });
}

/** AES-256-GCM wrap. Output: [12 IV][ciphertext][16 tag]. */
function wrap(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

/** AES-256-GCM unwrap. Throws (with a clear message) if the tag mismatches. */
function unwrap(payload: Buffer, key: Buffer): Buffer {
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new KekRotationError(
      `encrypted payload too short (${payload.length} bytes, need at least ${IV_BYTES + TAG_BYTES})`,
    );
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ct = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    throw new KekRotationError(
      'KEK unwrap failed — the old key does not match what the data was encrypted with. Refusing to continue.',
      err,
    );
  }
}

/**
 * Decode a KEK from its on-disk string form.
 *
 * Mirrors the parsing in settings.ts:295-309. Accepts either base64
 * (must decode to 32 bytes) or hex (must be 64 chars). Throws on
 * anything else so the CLI can give a clear "your key is malformed"
 * message instead of "wrong AES key length" at decrypt time.
 */
export function decodeKekString(s: string): Buffer {
  const trimmed = s.trim();
  // Try hex first — a 64-char hex string would also match the base64
  // regex below and decode to 48 bytes (the wrong answer). Hex is a
  // stricter format (only 0-9a-f, exactly 64 chars) so it's safe to
  // check first.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  if (/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
    const b = Buffer.from(trimmed, 'base64');
    if (b.length === 32) return b;
    throw new KekRotationError(
      `base64-decoded KEK is ${b.length} bytes; expected 32 (256-bit)`,
    );
  }
  throw new KekRotationError(
    'KEK must be base64-encoded 32 bytes or 64 hex characters',
  );
}

/** Generate a fresh 32-byte KEK + return its base64 form. */
export function generateNewKek(): { key: Buffer; base64: string } {
  const key = randomBytes(32);
  return { key, base64: key.toString('base64') };
}
