import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';

export const SESSION_COOKIE = 'smrtcash_session';

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
  activeTenantId: string | null;
  isSuperAdmin: boolean;
}

/** Create a session row + return the cookie value (the raw session id). */
export async function createSession(
  userId: string,
  activeTenantId: string | null = null,
): Promise<Session> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.auth.sessionMaxAgeMs);
  await query(
    `INSERT INTO sessions (id, user_id, expires_at, active_tenant_id)
     VALUES ($1, $2, $3, $4)`,
    [id, userId, expiresAt, activeTenantId],
  );
  // Look up the super-admin flag so the caller-facing Session shape
  // matches loadSession's. Cheap — one row on PK.
  const u = await pool.query<{ is_super_admin: boolean }>(
    `SELECT is_super_admin FROM users WHERE id = $1`,
    [userId],
  );
  return {
    id,
    userId,
    expiresAt,
    activeTenantId,
    isSuperAdmin: u.rows[0]?.is_super_admin ?? false,
  };
}

/** Look up a session by id. Returns null when missing OR expired. */
export async function loadSession(id: string): Promise<Session | null> {
  const r = await pool.query<{
    id: string;
    user_id: string;
    expires_at: Date;
    active_tenant_id: string | null;
    is_super_admin: boolean;
  }>(
    `SELECT s.id, s.user_id, s.expires_at, s.active_tenant_id,
            u.is_super_admin
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [id],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    activeTenantId: row.active_tenant_id,
    isSuperAdmin: row.is_super_admin,
  };
}

export async function setSessionTenant(
  id: string,
  tenantId: string,
): Promise<void> {
  await query(`UPDATE sessions SET active_tenant_id = $1 WHERE id = $2`, [
    tenantId,
    id,
  ]);
}

export async function deleteSession(id: string): Promise<void> {
  await query(`DELETE FROM sessions WHERE id = $1`, [id]);
}

/**
 * 0.16.2 — invalidate every session for a user. Called from
 * /api/auth/password-reset-confirm so that a successful reset
 * logs out any other browsers / devices that were authenticated
 * as that user. Standard anti-takeover hygiene.
 */
export async function deleteAllSessionsForUser(userId: string): Promise<number> {
  const r = await query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return r.rowCount ?? 0;
}

/** Best-effort prune of expired rows. Called occasionally from /api/auth/login. */
export async function pruneExpiredSessions(): Promise<void> {
  await query(`DELETE FROM sessions WHERE expires_at < now()`);
}
