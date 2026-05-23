import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';

export const SESSION_COOKIE = 'smrtcash_session';

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

/** Create a new session row and return the cookie value (the raw session id). */
export async function createSession(userId: string): Promise<Session> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.auth.sessionMaxAgeMs);
  await query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [id, userId, expiresAt],
  );
  return { id, userId, expiresAt };
}

/** Look up a session by id. Returns null when missing OR expired. */
export async function loadSession(id: string): Promise<Session | null> {
  const r = await pool.query<{ id: string; user_id: string; expires_at: Date }>(
    `SELECT id, user_id, expires_at
       FROM sessions
      WHERE id = $1 AND expires_at > now()`,
    [id],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
}

export async function deleteSession(id: string): Promise<void> {
  await query(`DELETE FROM sessions WHERE id = $1`, [id]);
}

/** Best-effort prune of expired rows. Called occasionally from /api/auth/login. */
export async function pruneExpiredSessions(): Promise<void> {
  await query(`DELETE FROM sessions WHERE expires_at < now()`);
}
