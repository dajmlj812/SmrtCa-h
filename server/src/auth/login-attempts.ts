import { pool } from '../db/pool.js';

/**
 * F-01 (security audit 2026-05-25) — Brute-force protection for the
 * local login endpoint.
 *
 * Rolling per-(email, ip) failure counter:
 *   • countRecentFailures(): how many failed attempts for this pair
 *     within the rate-limit window?
 *   • recordAttempt(): insert a row.
 *   • clearOnSuccess(): wipe rows after a successful login so a real
 *     user who fat-fingered a few times isn't penalized.
 *
 * The thresholds are tuned for a personal-finance product where a
 * real user might mistype a few times in a row. We allow MAX_ATTEMPTS
 * within WINDOW_MINUTES before returning 429.
 *
 * The lookup also runs a quick janitor (DELETE old rows) once every
 * ~100 calls to keep the table bounded. Sweep is bounded so a single
 * caller doesn't carry the cost of cleaning millions of rows.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

let lookupsSinceLastSweep = 0;
const SWEEP_EVERY_N_LOOKUPS = 100;

export interface RateLimitState {
  failures: number;
  blocked: boolean;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  email: string,
  ip: string,
): Promise<RateLimitState> {
  const emailLower = email.trim().toLowerCase();

  lookupsSinceLastSweep++;
  if (lookupsSinceLastSweep >= SWEEP_EVERY_N_LOOKUPS) {
    lookupsSinceLastSweep = 0;
    void pool
      .query(
        `DELETE FROM login_attempts
          WHERE attempted_at < now() - interval '1 hour'`,
      )
      .catch(() => undefined);
  }

  const r = await pool.query<{
    failures: string;
    oldest_attempted_at: string | null;
  }>(
    `SELECT COUNT(*)::text AS failures,
            MIN(attempted_at)::text AS oldest_attempted_at
       FROM login_attempts
      WHERE email_lower = $1
        AND ip = $2
        AND success = false
        AND attempted_at > now() - ($3::int * interval '1 minute')`,
    [emailLower, ip, WINDOW_MINUTES],
  );
  const failures = Number(r.rows[0]?.failures ?? '0');
  const blocked = failures >= MAX_ATTEMPTS;
  let retryAfterSeconds = 0;
  if (blocked && r.rows[0]?.oldest_attempted_at) {
    const oldest = new Date(r.rows[0].oldest_attempted_at).getTime();
    const windowEnds = oldest + WINDOW_MINUTES * 60_000;
    retryAfterSeconds = Math.max(0, Math.ceil((windowEnds - Date.now()) / 1000));
  }
  return { failures, blocked, retryAfterSeconds };
}

export async function recordAttempt(
  email: string,
  ip: string,
  success: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO login_attempts (email_lower, ip, success)
     VALUES (lower($1), $2, $3)`,
    [email, ip, success],
  );
}

export async function clearOnSuccess(email: string, ip: string): Promise<void> {
  await pool.query(
    `DELETE FROM login_attempts
      WHERE email_lower = lower($1) AND ip = $2`,
    [email, ip],
  );
}

export const __testing = { MAX_ATTEMPTS, WINDOW_MINUTES };
