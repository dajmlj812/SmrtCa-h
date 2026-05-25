import { createHash, randomBytes } from 'node:crypto';
import { pool, query } from '../db/pool.js';

/**
 * 0.18.4 — public-API token helpers.
 *
 * Token shape: `smrt_<43-char base64url>` — the `smrt_` prefix makes
 * the secret obviously a SmrtCash credential when it shows up in
 * logs or accidentally committed config; the 43-char body comes
 * from 32 random bytes encoded as URL-safe base64 without padding,
 * giving ~256 bits of entropy.
 *
 * We store only the SHA-256 of the token. A DB leak therefore
 * exposes hashes (uncrackable for a 256-bit secret) but not live
 * credentials. We also store `key_prefix` — the first 12 chars
 * including `smrt_` — so the UI can render "smrt_abc12345…" as a
 * stable identifier without the user having kept the full token.
 */

const PREFIX = 'smrt_';

export function generateToken(): {
  token: string;
  hash: string;
  prefix: string;
} {
  const token = PREFIX + randomBytes(32).toString('base64url');
  const hash = hashToken(token);
  const prefix = token.slice(0, 12);
  return { token, hash, prefix };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface ResolvedApiKey {
  id: string;
  userId: string;
  tenantId: string | null;
  scopes: 'read';
}

/**
 * Look up an API key by its presented token. Returns null when:
 *   - the token isn't a SmrtCash token (wrong prefix / length)
 *   - no row matches the hash
 *   - the row is revoked
 *
 * On a hit we update `last_used_at` and `last_used_ip` — fire-and-
 * forget (caller doesn't await) since the rate-limit signal is
 * eventually-consistent. Per-request cost is one SELECT + one UPDATE.
 */
export async function lookupKey(
  token: string,
  ip: string | null,
): Promise<ResolvedApiKey | null> {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  if (token.length < PREFIX.length + 40) return null;
  const hash = hashToken(token);
  const r = await query<{
    id: string;
    user_id: string;
    tenant_id: string | null;
    scopes: 'read';
    revoked_at: string | null;
    expires_at: string | null;
  }>(
    `SELECT id, user_id, tenant_id, scopes, revoked_at, expires_at
       FROM api_keys WHERE key_hash = $1`,
    [hash],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  if (row.revoked_at !== null) return null;
  // F-12 (security audit 2026-05-25) — refuse a key past its
  // optional expires_at, the same way we refuse a revoked one.
  if (row.expires_at !== null && new Date(row.expires_at).getTime() < Date.now()) {
    return null;
  }

  // Touch last-used asynchronously. Errors here would only mask
  // the rate-limit signal, so swallow them.
  pool
    .query(
      `UPDATE api_keys
          SET last_used_at = now(),
              last_used_ip = $2
        WHERE id = $1`,
      [row.id, ip],
    )
    .catch(() => undefined);

  return {
    id: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    scopes: row.scopes,
  };
}
