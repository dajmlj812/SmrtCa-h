/**
 * 0.18.13 — in-memory diagnostics ring buffers for /health.
 *
 * Two kinds of breadcrumbs the operator wants to look at on-demand:
 *
 *   • Recent warn/error log entries — when something's off, the
 *     operator should be able to open /health and see what the
 *     server has been complaining about lately, without SSHing in.
 *
 *   • Recent slow queries — anything over a threshold is captured
 *     with its SQL text + duration so we can spot the index/N+1
 *     opportunities without external APM.
 *
 * Both are bounded in-memory ring buffers (last N entries). They
 * survive a restart only if persisted — by design, they aren't.
 * The Health page polls these endpoints on demand, not on the
 * 5-second refresh cycle, so we don't run a SELECT per second.
 *
 * Cost: each capture is O(1). Memory: ~1.5 MB at the configured
 * caps (200 log entries × ~3 KB + 200 slow queries × ~1.5 KB).
 */

const MAX_LOG_ENTRIES = 200;
const MAX_SLOW_QUERIES = 200;

/**
 * Slow-query threshold (ms). Anything over this is captured.
 * Configurable via env so an operator who wants every query in the
 * buffer for an afternoon of debugging can set it to 0.
 */
const SLOW_QUERY_THRESHOLD_MS = Number(
  process.env.SLOW_QUERY_THRESHOLD_MS ?? '100',
);

export interface LogEntry {
  ts: string;
  level: 'warn' | 'error' | 'fatal';
  msg: string;
  /** Selected fields the operator usually wants to see (req id, error code, etc.) */
  context?: Record<string, unknown>;
}

export interface SlowQueryEntry {
  ts: string;
  duration_ms: number;
  /** First 500 chars of the SQL — enough to identify the query without bloating memory. */
  sql: string;
  /** Param count only — never the values, because params often carry PII or secrets. */
  param_count: number;
}

class DiagnosticsRecorder {
  private logs: LogEntry[] = [];
  private slow: SlowQueryEntry[] = [];

  recordLog(entry: LogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
    }
  }

  recordSlowQuery(sql: string, params: unknown[], durationMs: number): void {
    if (durationMs < SLOW_QUERY_THRESHOLD_MS) return;
    this.slow.push({
      ts: new Date().toISOString(),
      duration_ms: durationMs,
      // Strip whitespace runs so the snippet stays readable.
      sql: sql.replace(/\s+/g, ' ').trim().slice(0, 500),
      param_count: params.length,
    });
    if (this.slow.length > MAX_SLOW_QUERIES) {
      this.slow.splice(0, this.slow.length - MAX_SLOW_QUERIES);
    }
  }

  /** Returns the most recent N entries (newest last). */
  getLogs(limit = 50): LogEntry[] {
    return this.logs.slice(-limit);
  }

  /** Returns the slowest N queries from the buffer, sorted desc by duration. */
  getSlowQueries(limit = 50): SlowQueryEntry[] {
    return [...this.slow]
      .sort((a, b) => b.duration_ms - a.duration_ms)
      .slice(0, limit);
  }

  /** For tests. */
  reset(): void {
    this.logs = [];
    this.slow = [];
  }

  get slowQueryThresholdMs(): number {
    return SLOW_QUERY_THRESHOLD_MS;
  }
}

export const diagnosticsRecorder = new DiagnosticsRecorder();
