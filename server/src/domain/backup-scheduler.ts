import { getEffectiveValue } from './settings.js';
import { pruneOldBackups, runBackup } from './backup-runner.js';

/**
 * In-process scheduler: every 60 seconds, check the configured frequency
 * + time-of-day, and fire a backup when the current minute matches the
 * scheduled minute and the next-fire predicate is satisfied.
 *
 * No persistent cron state — `last_run_at` is read from the most-recent
 * successful row in `backups`, so a process restart doesn't lose track
 * of when the last backup happened.
 *
 * Disabled by default. The GUI flips BACKUP_ENABLED=true to turn it on.
 */

import { pool } from '../db/pool.js';

const TICK_MS = 60 * 1000; // one minute

let timer: ReturnType<typeof setInterval> | null = null;

export function startBackupScheduler(): void {
  if (timer) return; // already started
  timer = setInterval(() => void tick(), TICK_MS);
  // Don't hold the process open for the next tick — exit cleanly on SIGTERM.
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

    const frequency = (await getEffectiveValue('BACKUP_FREQUENCY')).toLowerCase() || 'daily';
    const timeStr = (await getEffectiveValue('BACKUP_TIME')) || '03:00';
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return;

    const now = new Date();
    if (now.getHours() !== hh || now.getMinutes() !== mm) return;

    if (!(await shouldRun(frequency, now))) return;

    const retDays =
      Number((await getEffectiveValue('BACKUP_RETENTION_DAYS')) || '30') || 30;
    const result = await runBackup({ kind: 'scheduled' });
    if (result.status === 'success' && retDays > 0) {
      await pruneOldBackups(retDays);
    }
  } catch {
    // Swallow scheduler errors — they'd otherwise crash the process via
    // an unhandled rejection on the interval callback. Failures land on
    // the backups row anyway.
  }
}

async function shouldRun(frequency: string, now: Date): Promise<boolean> {
  // Look up the most-recent successful run; compare to `now`.
  const r = await pool.query<{ d: string }>(
    `SELECT to_char(MAX(finished_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ') AS d
       FROM backups
      WHERE status = 'success'`,
  );
  const last = r.rows[0]?.d ? new Date(r.rows[0]!.d) : null;
  if (!last) return true; // never run

  const diffMs = now.getTime() - last.getTime();
  switch (frequency) {
    case 'hourly':
      return diffMs >= 60 * 60 * 1000;
    case 'daily':
      return diffMs >= 23 * 60 * 60 * 1000; // 23h guard against drift
    case 'weekly':
      return diffMs >= 6 * 24 * 60 * 60 * 1000;
    case 'monthly':
      return diffMs >= 28 * 24 * 60 * 60 * 1000;
    default:
      return diffMs >= 23 * 60 * 60 * 1000;
  }
}
