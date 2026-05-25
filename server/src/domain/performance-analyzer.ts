import { pool } from '../db/pool.js';
import { collectHealth } from './health.js';
import { metricsRecorder } from './metrics-recorder.js';
import { diagnosticsRecorder } from './diagnostics-recorder.js';

/**
 * 0.18.13 — runtime performance analyzer.
 *
 * Runs a fixed set of concrete checks against the current state and
 * returns a structured set of recommendations. Designed to be cheap
 * enough to run every 24h by default and on-demand via the "Run now"
 * button — under 1 second on a normal install.
 *
 * Each check is independent. Adding a new one means adding a CHECKS
 * entry; the analyzer just runs them all and rolls up the results.
 *
 * The output is "what would I tell an operator who just opened the
 * health page?" — actionable observations, not a guess at a future
 * problem. Static architecture recommendations (lazy-load this,
 * split that worker) live in docs/PERFORMANCE_RECOMMENDATIONS.md;
 * those don't change minute to minute and don't belong in a
 * dynamic-refresh widget.
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface Recommendation {
  id: string;
  severity: Severity;
  title: string;
  /** One-sentence what's-happening. */
  summary: string;
  /** Concrete numbers / signals supporting the finding. */
  evidence: string;
  /** What to do — short, imperative. */
  recommendation: string;
  /** Rough lift estimate. */
  effort: 'low' | 'medium' | 'high';
}

export interface PerformanceReport {
  generated_at: string;
  duration_ms: number;
  /** Total check count attempted, including ones that produced no recommendation. */
  checks_run: number;
  /** Issues found — sorted critical → warning → info. */
  recommendations: Recommendation[];
}

/**
 * Run every check, collect any recommendations, return a report.
 * Total runtime is the slowest check (most are <50ms); the whole
 * report normally lands in <500ms.
 */
export async function runPerformanceAnalysis(): Promise<PerformanceReport> {
  const started = Date.now();
  const recs: Recommendation[] = [];

  // Cheap fan-out: every check returns a (possibly empty) array of
  // recommendations. We don't fail the whole report if one check
  // throws — log and continue so an operator never sees a 500 here.
  const results = await Promise.allSettled(CHECKS.map((c) => c()));
  for (const r of results) {
    if (r.status === 'fulfilled') {
      recs.push(...r.value);
    }
    // Rejected checks: their failure is itself a possible signal,
    // but we don't want to flood the UI. Silent skip is fine.
  }

  recs.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  return {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    checks_run: CHECKS.length,
    recommendations: recs,
  };
}

function severityRank(s: Severity): number {
  if (s === 'critical') return 3;
  if (s === 'warning') return 2;
  return 1;
}

// ── Individual checks ────────────────────────────────────────

type Check = () => Promise<Recommendation[]>;

const CHECKS: Check[] = [
  checkDbPoolPressure,
  checkSlowQueriesPresent,
  checkMeanQueryLatency,
  checkHeapPressure,
  checkEventLoopLag,
  checkErrorRate,
  checkDiskCapacity,
  checkBackupOverdue,
  checkCapacitySnapshotFreshness,
  checkSequentialScansHigh,
  checkOcrBacklog,
  checkRecentLogErrors,
];

/**
 * Pool waiting for an available client = either pool too small or
 * queries too slow. We only flag *sustained* pressure — a single
 * waiter on one sample is normal sub-millisecond contention (the
 * entire reason a connection pool has a queue), not a problem.
 *
 * Definitions:
 *   • Sustained pressure: ≥ 3 of the last 12 samples (≈ 1 minute at
 *     5s sampling) had db_pool_waiting > 0.
 *   • Severe spike: any sample had db_pool_waiting ≥ db_pool_total
 *     (queue longer than the pool itself).
 */
async function checkDbPoolPressure(): Promise<Recommendation[]> {
  // Look back over the last 5 minutes, but only weight the most recent
  // minute for the sustained-pressure threshold.
  const samples = metricsRecorder.getTimeseries(300);
  if (samples.length === 0) return [];

  const recent = samples.slice(-12);
  const samplesWithWaiters = recent.filter((s) => s.db_pool_waiting > 0);
  const peakSpike = samples.reduce(
    (acc, s) =>
      s.db_pool_total > 0 && s.db_pool_waiting >= s.db_pool_total ? s : acc,
    null as (typeof samples)[number] | null,
  );

  const latest = samples[samples.length - 1]!;
  const sustained = samplesWithWaiters.length >= 3;
  if (!sustained && !peakSpike) return [];

  const peak = samplesWithWaiters.reduce(
    (acc, s) => (s.db_pool_waiting > acc ? s.db_pool_waiting : acc),
    0,
  );
  const evidenceLine = peakSpike
    ? `severe spike: ${peakSpike.db_pool_waiting} queued ≥ ${peakSpike.db_pool_total}-conn pool`
    : `${samplesWithWaiters.length} of last ${recent.length} samples had waiters (peak ${peak} queued, pool size ${latest.db_pool_total})`;

  return [
    {
      id: 'db.pool_pressure',
      severity: peakSpike ? 'critical' : 'warning',
      title: 'Database connection pool under sustained pressure',
      summary: 'Requests are blocking on a free DB connection.',
      evidence: evidenceLine,
      recommendation:
        'Increase the PG_POOL_MAX setting OR investigate why queries are slow enough to starve the pool. Slow-query log is a good first stop.',
      effort: 'low',
    },
  ];
}

async function checkSlowQueriesPresent(): Promise<Recommendation[]> {
  const slow = diagnosticsRecorder.getSlowQueries(20);
  if (slow.length === 0) return [];
  const over1s = slow.filter((s) => s.duration_ms >= 1000).length;
  const over500 = slow.filter((s) => s.duration_ms >= 500).length;
  const top = slow[0]!;
  if (over1s > 0) {
    return [
      {
        id: 'db.slow_queries_critical',
        severity: 'critical',
        title: `${over1s} query/queries crossed 1 second`,
        summary: 'Postgres is serving at least one query that takes more than a second.',
        evidence: `slowest: ${top.duration_ms} ms · "${top.sql.slice(0, 80)}..."`,
        recommendation:
          'Open /health → Slow queries panel for the full SQL text. Common causes: missing index, sequential scan on a large table, or a hot row contention. EXPLAIN the offending query to confirm.',
        effort: 'medium',
      },
    ];
  }
  if (over500 > 0) {
    return [
      {
        id: 'db.slow_queries_warning',
        severity: 'warning',
        title: `${over500} query/queries crossed 500 ms`,
        summary: 'Some queries are running slower than the 500ms warn threshold.',
        evidence: `slowest: ${top.duration_ms} ms · "${top.sql.slice(0, 80)}..."`,
        recommendation:
          'Open /health → Slow queries panel for the full SQL. Worth EXPLAIN-ing if the same pattern keeps repeating.',
        effort: 'low',
      },
    ];
  }
  return [];
}

async function checkMeanQueryLatency(): Promise<Recommendation[]> {
  const latest = metricsRecorder.latest();
  if (!latest) return [];
  if (latest.db_query_mean_ms > 50 && latest.db_query_count > 10) {
    return [
      {
        id: 'db.mean_latency_high',
        severity: 'warning',
        title: 'Mean DB query latency above 50 ms',
        summary: 'Even average queries are taking longer than they should.',
        evidence: `current mean: ${latest.db_query_mean_ms.toFixed(1)} ms over ${latest.db_query_count} queries in the last 5s`,
        recommendation:
          'If sustained, look at the slow-query log + run EXPLAIN on the dashboard query. May also indicate a saturated host (check CPU/memory gauges).',
        effort: 'medium',
      },
    ];
  }
  return [];
}

async function checkHeapPressure(): Promise<Recommendation[]> {
  const samples = metricsRecorder.getTimeseries(60);
  if (samples.length === 0) return [];
  const latest = samples[samples.length - 1]!;
  // heap_size_limit_bytes is V8's hard ceiling (= --max-old-space-size).
  // The OLD code used heap_total_bytes, which is V8's currently-allocated
  // heap — that grows on demand, so heap_used / heap_total is almost
  // always close to 1.0 and produced false "OOM imminent" recommendations
  // even on a process holding 32 MB.
  const limit = latest.heap_size_limit_bytes;
  if (!limit || limit < 1) return [];
  const ratio = latest.heap_used_bytes / limit;
  if (ratio > 0.85) {
    return [
      {
        id: 'node.heap_pressure_critical',
        severity: 'critical',
        title: 'Node heap usage above 85% of limit',
        summary: 'The process is close to its memory ceiling and may OOM.',
        evidence: `heap_used=${(latest.heap_used_bytes / 1_048_576).toFixed(0)} MB of ~${(limit / 1_048_576).toFixed(0)} MB`,
        recommendation:
          'Restart the container to free up — and provision more memory at the host. Capture a heapdump first if this happens repeatedly.',
        effort: 'low',
      },
    ];
  }
  if (ratio > 0.7) {
    return [
      {
        id: 'node.heap_pressure_warning',
        severity: 'warning',
        title: 'Node heap usage above 70% of limit',
        summary: 'Heap utilization is high but not critical.',
        evidence: `${(ratio * 100).toFixed(1)}% used`,
        recommendation:
          'Monitor over the next hour. If the trend continues, plan a memory bump.',
        effort: 'low',
      },
    ];
  }
  return [];
}

async function checkEventLoopLag(): Promise<Recommendation[]> {
  const samples = metricsRecorder.getTimeseries(300);
  if (samples.length === 0) return [];
  const recent = samples.slice(-12); // last ~1 minute at 5s sampling
  const maxP99 = Math.max(...recent.map((s) => s.event_loop_p99_ms));
  if (maxP99 > 200) {
    return [
      {
        id: 'node.event_loop_lag_critical',
        severity: 'critical',
        title: 'Event loop p99 lag > 200 ms',
        summary: 'Something synchronous is blocking the event loop, hurting every concurrent request.',
        evidence: `recent peak p99: ${maxP99.toFixed(0)} ms`,
        recommendation:
          'Hunt for sync work on the hot path: large JSON.parse, sync fs ops, big regex. The OCR sweep is a known culprit when Claude vision wedges — see F-15 server timeout.',
        effort: 'medium',
      },
    ];
  }
  if (maxP99 > 50) {
    return [
      {
        id: 'node.event_loop_lag_warning',
        severity: 'warning',
        title: 'Event loop p99 lag > 50 ms',
        summary: 'Mild event-loop pressure; could affect tail latency.',
        evidence: `recent peak p99: ${maxP99.toFixed(0)} ms`,
        recommendation:
          'Probably acceptable but worth checking the next time you make a perf pass.',
        effort: 'low',
      },
    ];
  }
  return [];
}

async function checkErrorRate(): Promise<Recommendation[]> {
  const samples = metricsRecorder.getTimeseries(300);
  if (samples.length === 0) return [];
  const recent = samples.slice(-60); // last 5 minutes
  const totalReq = recent.reduce((acc, s) => acc + s.req_count, 0);
  const totalErr = recent.reduce((acc, s) => acc + s.err_count, 0);
  if (totalReq < 20) return []; // not enough traffic to be a meaningful rate
  const errRate = totalErr / totalReq;
  if (errRate > 0.05) {
    return [
      {
        id: 'http.error_rate_critical',
        severity: 'critical',
        title: `HTTP 5xx rate above 5% (${(errRate * 100).toFixed(1)}%)`,
        summary: 'A meaningful fraction of recent requests are failing with 5xx.',
        evidence: `${totalErr} 5xx / ${totalReq} requests in the last 5 minutes`,
        recommendation:
          'Open /health → Recent warnings & errors for the actual exceptions. Cancel any deploy in progress if applicable.',
        effort: 'medium',
      },
    ];
  }
  if (errRate > 0.01) {
    return [
      {
        id: 'http.error_rate_warning',
        severity: 'warning',
        title: `HTTP 5xx rate above 1% (${(errRate * 100).toFixed(1)}%)`,
        summary: 'Some requests are failing — worth investigating.',
        evidence: `${totalErr} 5xx / ${totalReq} requests`,
        recommendation: 'Check the warnings & errors panel for which routes.',
        effort: 'low',
      },
    ];
  }
  return [];
}

async function checkDiskCapacity(): Promise<Recommendation[]> {
  const h = await collectHealth();
  const recs: Recommendation[] = [];
  for (const d of h.host.disks) {
    if (d.percent_used >= 95) {
      recs.push({
        id: `disk.${d.label}.critical`,
        severity: 'critical',
        title: `Disk "${d.label}" is ${d.percent_used.toFixed(1)}% full`,
        summary: 'Disk almost full. Writes will fail soon.',
        evidence: `${(d.used_bytes / 1_073_741_824).toFixed(1)} GB / ${(d.total_bytes / 1_073_741_824).toFixed(1)} GB`,
        recommendation:
          'Free space immediately (prune old backups, archive attachments to S3) and plan the next-tier-VM migration today. See /health → Server capacity for the projected swap date.',
        effort: 'high',
      });
    } else if (d.percent_used >= 80) {
      recs.push({
        id: `disk.${d.label}.warning`,
        severity: 'warning',
        title: `Disk "${d.label}" is ${d.percent_used.toFixed(1)}% full`,
        summary: 'Plan to grow capacity within the next month.',
        evidence: `${(d.used_bytes / 1_073_741_824).toFixed(1)} GB used`,
        recommendation: 'Schedule the migration. The capacity widget gives an exact "prepare by" date.',
        effort: 'medium',
      });
    }
  }
  return recs;
}

async function checkBackupOverdue(): Promise<Recommendation[]> {
  const r = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM backups
      WHERE status = 'success'
      ORDER BY created_at DESC LIMIT 1`,
  );
  if (r.rowCount === 0) {
    return [
      {
        id: 'ops.no_backups',
        severity: 'critical',
        title: 'No successful backups recorded',
        summary: 'No backup has ever succeeded on this instance.',
        evidence: 'backups table has no status=success rows',
        recommendation:
          'Run `npm run backup` manually now, then configure BACKUP_ENABLED=true + BACKUP_FREQUENCY in Settings so the scheduler runs daily.',
        effort: 'low',
      },
    ];
  }
  const ageMs = Date.now() - r.rows[0]!.created_at.getTime();
  const ageHours = ageMs / 3_600_000;
  if (ageHours > 48) {
    return [
      {
        id: 'ops.backup_overdue',
        severity: 'warning',
        title: `Last backup was ${Math.floor(ageHours)} hours ago`,
        summary: 'Backup scheduler may have stopped, or the schedule is too sparse.',
        evidence: `last successful backup at ${r.rows[0]!.created_at.toISOString()}`,
        recommendation:
          'Check BACKUP_ENABLED + BACKUP_FREQUENCY in Settings. Run `npm run backup` to verify the script still works.',
        effort: 'low',
      },
    ];
  }
  return [];
}

async function checkCapacitySnapshotFreshness(): Promise<Recommendation[]> {
  const r = await pool.query<{ snapshot_date: string }>(
    `SELECT snapshot_date::text FROM health_capacity_snapshots
      ORDER BY snapshot_date DESC LIMIT 1`,
  );
  if (r.rowCount === 0) {
    return [
      {
        id: 'ops.no_capacity_snapshots',
        severity: 'info',
        title: 'No capacity-projection data yet',
        summary: 'The /health Server capacity widget needs ≥3 days of snapshots to project.',
        evidence: 'health_capacity_snapshots is empty',
        recommendation:
          'Snapshots populate automatically as the operator visits /health and after each successful backup. Nothing to do unless this is still showing in a week.',
        effort: 'low',
      },
    ];
  }
  return [];
}

async function checkSequentialScansHigh(): Promise<Recommendation[]> {
  // pg_stat_user_tables is built-in; no extension needed.
  // Flag any table where seq_tup_read >> idx_tup_fetch on a big table.
  const r = await pool.query<{
    relname: string;
    seq_scan: number;
    idx_scan: number | null;
    n_live_tup: number;
  }>(
    `SELECT relname, seq_scan, idx_scan, n_live_tup
       FROM pg_stat_user_tables
      WHERE n_live_tup > 1000
        AND seq_scan > 1000
        AND (idx_scan IS NULL OR seq_scan > 5 * COALESCE(idx_scan, 0))
      ORDER BY n_live_tup DESC
      LIMIT 5`,
  );
  return r.rows.map((row) => ({
    id: `db.seq_scan.${row.relname}`,
    severity: 'warning' as const,
    title: `Table "${row.relname}" is being scanned sequentially`,
    summary: `Postgres is preferring seqscan over index scans on a ${row.n_live_tup.toLocaleString()}-row table.`,
    evidence: `seq_scan=${row.seq_scan.toLocaleString()} · idx_scan=${(row.idx_scan ?? 0).toLocaleString()}`,
    recommendation:
      `Add an index on the column(s) the hot WHERE clause filters by. EXPLAIN ANALYZE the routes that hit "${row.relname}" to find them.`,
    effort: 'medium',
  }));
}

async function checkOcrBacklog(): Promise<Recommendation[]> {
  const r = await pool.query<{ n: string; oldest: Date | null }>(
    `SELECT COUNT(*)::text AS n, MIN(created_at) AS oldest
       FROM attachments
      WHERE ocr_status = 'pending'`,
  );
  const n = Number(r.rows[0]?.n ?? '0');
  if (n === 0) return [];
  const oldest = r.rows[0]!.oldest;
  if (!oldest) return [];
  const ageMin = (Date.now() - oldest.getTime()) / 60_000;
  if (ageMin > 30) {
    return [
      {
        id: 'ocr.backlog',
        severity: 'warning',
        title: `${n} attachment(s) stuck in OCR pending`,
        summary: 'The Claude vision call may be wedged or the provider has issues.',
        evidence: `oldest pending: ${ageMin.toFixed(0)} minutes old`,
        recommendation:
          'Check the Anthropic API status. Restart the container to re-trigger the OCR sweep (F-15 timeout will mark stuck ones failed).',
        effort: 'low',
      },
    ];
  }
  return [];
}

async function checkRecentLogErrors(): Promise<Recommendation[]> {
  const logs = diagnosticsRecorder.getLogs(200);
  const errors = logs.filter((l) => l.level === 'error' || l.level === 'fatal');
  if (errors.length === 0) return [];
  if (errors.length >= 10) {
    return [
      {
        id: 'logs.errors_critical',
        severity: 'critical',
        title: `${errors.length} error log entries in the buffer`,
        summary: 'Something is repeatedly failing.',
        evidence: `most recent: "${errors[errors.length - 1]!.msg.slice(0, 100)}"`,
        recommendation:
          'Open /health → Recent warnings & errors for the full list. Look for repeated reqId or error code patterns.',
        effort: 'medium',
      },
    ];
  }
  return [
    {
      id: 'logs.errors_warning',
      severity: 'warning',
      title: `${errors.length} recent error log entries`,
      summary: 'Some recent requests have thrown.',
      evidence: `most recent: "${errors[errors.length - 1]!.msg.slice(0, 100)}"`,
      recommendation:
        'Check the warnings & errors panel — if they cluster around one route, that route deserves attention.',
      effort: 'low',
    },
  ];
}
