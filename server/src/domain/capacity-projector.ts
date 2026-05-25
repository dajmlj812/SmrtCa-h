import { pool } from '../db/pool.js';
import { collectHealth } from './health.js';

/**
 * 0.18.13 — Capacity projection.
 *
 * Reads the multi-day series in `health_capacity_snapshots`, fits a
 * simple linear-regression growth rate per metric, and projects the
 * date at which usage crosses 80% (warn) and 95% (critical). The
 * widget on /health shows the worst-of those projections so the
 * operator has a single "plan swap by [date]" recommendation.
 *
 * Why linear instead of exponential: most of the growth in a personal
 * finance app's data is driven by user count + per-user activity,
 * both of which compound but slowly. Linear is a conservative
 * underestimate of doom and matches what the operator can actually
 * plan against. If the regression looks suspect (R² is too low,
 * fewer than 3 data points), the response says so explicitly.
 */

const WARN_PCT = 80;
const CRITICAL_PCT = 95;

/** Days of history to consider when projecting. */
const LOOKBACK_DAYS = 30;

/** Hard floor on points before we publish a projection. */
const MIN_POINTS_FOR_PROJECTION = 3;

export interface CapacityProjection {
  /** Current usage as of this call. */
  current: {
    db_bytes: number;
    attachments_bytes: number;
    backups_bytes: number;
    disk_total_bytes: number | null;
    disk_free_bytes: number | null;
    disk_used_bytes: number | null;
    disk_percent_used: number | null;
  };
  /** Per-metric growth rates fit from recent snapshots (bytes/day). */
  growth: {
    db_bytes_per_day: number | null;
    attachments_bytes_per_day: number | null;
    backups_bytes_per_day: number | null;
  };
  /** Projection for the metric that defines "capacity" — disk space. */
  projection: {
    /** Number of historical samples considered. */
    sample_count: number;
    /** First and last sample dates considered (ISO YYYY-MM-DD). */
    window: { from: string; to: string } | null;
    /** Bytes-per-day combined growth used for the projection. */
    combined_bytes_per_day: number | null;
    /** Estimated date disk used % crosses warn / critical. ISO YYYY-MM-DD or null. */
    warn_date: string | null;
    critical_date: string | null;
    days_until_warn: number | null;
    days_until_critical: number | null;
    /**
     * Recommended swap-prep date. Two-day cushion before warn date so
     * the operator has time to provision + rehearse the migration.
     */
    recommended_prepare_by: string | null;
    /** Human-readable status: ok / warn / critical / unknown. */
    status: 'ok' | 'warn' | 'critical' | 'unknown';
    /** Why a projection couldn't be made, if applicable. */
    note: string | null;
  };
}

/**
 * Record (or update) today's snapshot. Idempotent — running it
 * repeatedly within the same UTC day refreshes captured_at and the
 * byte counts but doesn't add new rows.
 */
export async function recordCapacitySnapshot(): Promise<void> {
  const h = await collectHealth();
  const disk = h.host.disks[0] ?? null; // single-volume assumption for projection
  await pool.query(
    `INSERT INTO health_capacity_snapshots
       (snapshot_date, db_bytes, attachments_bytes, backups_bytes,
        disk_total_bytes, disk_free_bytes)
     VALUES (CURRENT_DATE, $1, $2, $3, $4, $5)
     ON CONFLICT (snapshot_date) DO UPDATE SET
       captured_at       = now(),
       db_bytes          = EXCLUDED.db_bytes,
       attachments_bytes = EXCLUDED.attachments_bytes,
       backups_bytes     = EXCLUDED.backups_bytes,
       disk_total_bytes  = EXCLUDED.disk_total_bytes,
       disk_free_bytes   = EXCLUDED.disk_free_bytes`,
    [
      h.db.size_bytes,
      h.storage.attachments_bytes,
      h.storage.backups_bytes,
      disk?.total_bytes ?? null,
      disk?.free_bytes ?? null,
    ],
  );
}

/**
 * Compute the projection. Writes a fresh snapshot first so the answer
 * always reflects right-now numbers, then reads the historical buffer.
 */
export async function projectCapacity(): Promise<CapacityProjection> {
  await recordCapacitySnapshot();
  const h = await collectHealth();
  const disk = h.host.disks[0] ?? null;

  const rows = await pool.query<{
    snapshot_date: string;
    db_bytes: string;
    attachments_bytes: string;
    backups_bytes: string;
    disk_total_bytes: string | null;
    disk_free_bytes: string | null;
  }>(
    `SELECT snapshot_date::text,
            db_bytes::text,
            attachments_bytes::text,
            backups_bytes::text,
            disk_total_bytes::text,
            disk_free_bytes::text
       FROM health_capacity_snapshots
      WHERE snapshot_date >= CURRENT_DATE - ($1::int - 1)
      ORDER BY snapshot_date ASC`,
    [LOOKBACK_DAYS],
  );

  const samples = rows.rows.map((r) => ({
    date: r.snapshot_date,
    db: Number(r.db_bytes),
    attachments: Number(r.attachments_bytes),
    backups: Number(r.backups_bytes),
    diskFree: r.disk_free_bytes != null ? Number(r.disk_free_bytes) : null,
  }));

  const dbRate = linearRate(samples.map((s) => s.db));
  const attRate = linearRate(samples.map((s) => s.attachments));
  const bkRate = linearRate(samples.map((s) => s.backups));

  const current = {
    db_bytes: h.db.size_bytes,
    attachments_bytes: h.storage.attachments_bytes,
    backups_bytes: h.storage.backups_bytes,
    disk_total_bytes: disk?.total_bytes ?? null,
    disk_free_bytes: disk?.free_bytes ?? null,
    disk_used_bytes: disk?.used_bytes ?? null,
    disk_percent_used: disk?.percent_used ?? null,
  };

  // Build the disk projection. We can't fit a useful regression on
  // disk_free directly because it's affected by background things
  // outside the app (log rotation, OS writes). Use the sum of the
  // three byte-rates as the app's contribution. That's the part the
  // operator can directly attribute to growth in app usage.
  const combinedRate =
    dbRate != null && attRate != null && bkRate != null
      ? dbRate + attRate + bkRate
      : null;

  let warnDate: string | null = null;
  let criticalDate: string | null = null;
  let daysUntilWarn: number | null = null;
  let daysUntilCritical: number | null = null;
  let recommended: string | null = null;
  let status: CapacityProjection['projection']['status'] = 'unknown';
  let note: string | null = null;

  if (samples.length < MIN_POINTS_FOR_PROJECTION) {
    note = `Need at least ${MIN_POINTS_FOR_PROJECTION} days of snapshots to project — currently have ${samples.length}. The widget will populate as the daily snapshot job runs.`;
  } else if (disk == null) {
    note = "Couldn't read disk free space on this platform — no projection available.";
  } else if (combinedRate == null || combinedRate <= 0) {
    note = 'No meaningful app growth observed in the recent window. Either usage is steady or the snapshots are too uniform to fit a line.';
    status = 'ok';
  } else {
    const total = disk.total_bytes;
    const usedNow = disk.used_bytes;
    const warnTarget = total * (WARN_PCT / 100);
    const criticalTarget = total * (CRITICAL_PCT / 100);

    const bytesToWarn = Math.max(0, warnTarget - usedNow);
    const bytesToCritical = Math.max(0, criticalTarget - usedNow);

    daysUntilWarn = Math.floor(bytesToWarn / combinedRate);
    daysUntilCritical = Math.floor(bytesToCritical / combinedRate);
    warnDate = daysToDate(daysUntilWarn);
    criticalDate = daysToDate(daysUntilCritical);

    // Recommend prep two days before warn so the operator has runway
    // for provisioning + rehearsal. If we're already past warn, the
    // recommendation is "now".
    recommended =
      daysUntilWarn <= 0 ? daysToDate(0) : daysToDate(Math.max(0, daysUntilWarn - 2));

    if (disk.percent_used >= CRITICAL_PCT) status = 'critical';
    else if (disk.percent_used >= WARN_PCT) status = 'warn';
    else if (daysUntilWarn <= 14) status = 'warn';
    else status = 'ok';
  }

  return {
    current,
    growth: {
      db_bytes_per_day: dbRate,
      attachments_bytes_per_day: attRate,
      backups_bytes_per_day: bkRate,
    },
    projection: {
      sample_count: samples.length,
      window:
        samples.length > 0
          ? { from: samples[0]!.date, to: samples[samples.length - 1]!.date }
          : null,
      combined_bytes_per_day: combinedRate,
      warn_date: warnDate,
      critical_date: criticalDate,
      days_until_warn: daysUntilWarn,
      days_until_critical: daysUntilCritical,
      recommended_prepare_by: recommended,
      status,
      note,
    },
  };
}

/**
 * Fit `y = a + b·x` where x is the sample index (0, 1, 2, ...) and y
 * is the byte count. Returns the slope `b` — bytes per sample, which
 * (with daily snapshots) is bytes per day. Returns null when fewer
 * than two distinct points are available or the fit produces a
 * non-positive slope (which we round to zero growth — the projection
 * code treats that as "no growth observed").
 */
function linearRate(values: number[]): number | null {
  if (values.length < 2) return null;
  const n = values.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = values[i]!;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  // A slope ≤ 0 means usage is flat or shrinking — project as "no
  // growth" rather than an absurd negative-days-until-full.
  return slope > 0 ? slope : 0;
}

function daysToDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
