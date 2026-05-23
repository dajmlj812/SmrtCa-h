import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';

export const SESSION_COOKIE = 'smrtcash_session';

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
  activeTenantId: string | null;
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
  return { id, userId, expiresAt, activeTenantId };
}

/** Look up a session by id. Returns null when missing OR expired. */
export async function loadSession(id: string): Promise<Session | null> {
  const r = await pool.query<{
    id: string;
    user_id: string;
    expires_at: Date;
    active_tenant_id: string | null;
  }>(
    `SELECT id, user_id, expires_at, active_tenant_id
       FROM sessions
      WHERE id = $1 AND expires_at > now()`,
    [id],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    activeTenantId: row.active_tenant_id,
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

/** Best-effort prune of expired rows. Called occasionally from /api/auth/login. */
export async function pruneExpiredSessions(): Promise<void> {
  await query(`DELETE FROM sessions WHERE expires_at < now()`);
}
