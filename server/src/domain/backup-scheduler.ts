import { getEffectiveValue } from './settings.js';
import { pruneOldBackups, runBackup } from './backup-runner.js';
import { pool } from '../db/pool.js';

/**
 * In-process backup scheduler.
 *
 * Tick every 60s. Each tick:
 *   1. If BACKUP_ENABLED is false → no-op.
 *   2. Parse BACKUP_FREQUENCY + BACKUP_TIME (HH:MM, container-local TZ).
 *   3. If the scheduled time for the current period has NOT yet passed
 *      → no-op (don't fire early).
 *   4. If the cadence gate (`shouldRun`) says the last successful run
 *      is recent enough → no-op (don't fire twice in the same window).
 *   5. Otherwise fire the backup + prune old artifacts.
 *
 * The 0.9.3 → 0.9.4 fix: the previous version compared `now.getHours()`
 * and `now.getMinutes()` for an EXACT match against the scheduled HH:MM.
 * setInterval drift meant the 60-second tick could skip the target
 * minute entirely, so daily backups silently never fired. The new logic
 * uses a "scheduled instant has passed today" predicate, which is wide
 * (24h per day) and combines with the cadence gate to prevent double-
 * firing.
 *
 * Timezone: BACKUP_TIME is interpreted in the *container's* local time.
 * The Docker image runs UTC by default, so "03:00" means 3 a.m. UTC. To
 * schedule against a different zone, set the container's `TZ` env var
 * (e.g. TZ=America/New_York) in docker-compose.yml. A future setting
 * could surface this in the GUI.
 */

const TICK_MS = 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

export function startBackupScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopBackupScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  try {
    const enabled =
      (await getEffectiveValue('BACKUP_ENABLED')).toLowerCase() === 'true';
    if (!enabled) return;

    const frequency =
      (await getEffectiveValue('BACKUP_FREQUENCY')).toLowerCase() || 'daily';
    const timeStr = (await getEffectiveValue('BACKUP_TIME')) || '03:00';
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return;

    const now = new Date();
    // "Scheduled instant for the current period." For hourly we don't
    // care about HH — fire whenever the cadence gate passes. For the
    // other frequencies we wait until the scheduled HH:MM has passed.
    if (frequency !== 'hourly') {
      const scheduledToday = new Date(now);
      scheduledToday.setHours(hh, mm, 0, 0);
      if (now < scheduledToday) return;
    }

    if (!(await shouldRun(frequency, now))) return;

    const retDays =
      Number((await getEffectiveValue('BACKUP_RETENTION_DAYS')) || '30') || 30;
    const result = await runBackup({ kind: 'scheduled' });
    if (result.status === 'success' && retDays > 0) {
      await pruneOldBackups(retDays);
    }
  } catch {
    // Swallow scheduler errors so an unhandled rejection on the
    // interval callback doesn't crash the process. Failures still
    // surface on the backups row.
  }
}

async function shouldRun(frequency: string, now: Date): Promise<boolean> {
  // Look up the most-recent successful run; compare to `now`.
  // For 'daily' (and weekly/monthly), the gate is "elapsed since last
  // success" — combined with the "scheduled time has passed" check in
  // tick(), this gives the user a daily-at-03:00 cadence even though
  // ticks fire every minute.
  const r = await pool.query<{ d: string }>(
    `SELECT to_char(MAX(finished_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ') AS d
       FROM backups
      WHERE status = 'success' AND kind = 'scheduled'`,
  );
  const last = r.rows[0]?.d ? new Date(r.rows[0]!.d) : null;
  if (!last) return true;

  const diffMs = now.getTime() - last.getTime();
  switch (frequency) {
    case 'hourly':
      return diffMs >= 60 * 60 * 1000 - 60_000; // 59 min — tolerate jitter
    case 'daily':
      return diffMs >= 23 * 60 * 60 * 1000;
    case 'weekly':
      return diffMs >= 6 * 24 * 60 * 60 * 1000;
    case 'monthly':
      return diffMs >= 28 * 24 * 60 * 60 * 1000;
    default:
      return diffMs >= 23 * 60 * 60 * 1000;
  }
}
