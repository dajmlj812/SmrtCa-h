import { monitorEventLoopDelay, type EventLoopUtilization, performance } from 'node:perf_hooks';

/**
 * In-process rolling buffer of operational metrics for the Health page.
 *
 * Sampled every SAMPLE_MS into a circular array of MAX_POINTS entries
 * (= 1 hour at 5s resolution). Each sample collapses every counter
 * the app has incremented since the previous sample into rates, so the
 * UI can chart "requests per second" without having to differentiate
 * a cumulative counter itself.
 *
 * Counters live as flat fields on the recorder; the request and DB
 * instrumentation hooks bump them. They reset on every sample().
 *
 * Cost-of-collection: ~1ms per sample. The recorder runs on a single
 * Node interval; if it falls behind under load (unlikely at 5s), the
 * gap just shows up as a missing point on the chart.
 */

const SAMPLE_MS = 5000;
const MAX_POINTS = (60 * 60_000) / SAMPLE_MS; // 720 points = 1 hour

export interface MetricSample {
  /** ISO timestamp at the end of the sample window. */
  ts: string;
  /** % CPU consumed by THIS process over the last window. 0..100+ on multi-core. */
  cpu_pct: number;
  /** Resident-set size in bytes (real memory). */
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  /** Mean event-loop delay over the window, in ms. */
  event_loop_mean_ms: number;
  /** 99th-percentile event-loop delay over the window, in ms. */
  event_loop_p99_ms: number;
  /** Event-loop utilization 0..1 (1 = saturated). */
  event_loop_util: number;
  /** Requests served in the window. */
  req_count: number;
  /** Requests / second over the window. */
  req_rate: number;
  /** Responses with status >= 500 in the window. */
  err_count: number;
  /** errors / total requests in the window (0..1). NaN-safe (0 when no traffic). */
  err_rate: number;
  /** DB queries executed in the window. */
  db_query_count: number;
  /** queries / second over the window. */
  db_query_rate: number;
  /** Mean query latency in the window, ms. 0 when no queries. */
  db_query_mean_ms: number;
  /** Max query latency in the window, ms. 0 when no queries. */
  db_query_max_ms: number;
}

class MetricsRecorder {
  // Buffer is a fixed-length array; head is the most-recent index.
  private buffer: MetricSample[] = [];

  // Counters reset every sample().
  private reqCount = 0;
  private errCount = 0;
  private dbQueryCount = 0;
  private dbQueryTotalMs = 0;
  private dbQueryMaxMs = 0;

  // CPU bookkeeping — process.cpuUsage() returns microseconds.
  private lastCpu = process.cpuUsage();
  private lastSampleTime = Date.now();
  private lastElu: EventLoopUtilization | null = performance.eventLoopUtilization?.() ?? null;

  // Event-loop delay observer — non-blocking, populated by the runtime.
  private eluHistogram = monitorEventLoopDelay({ resolution: 20 });

  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;
    this.eluHistogram.enable();
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.eluHistogram.disable();
  }

  // ── Counter hooks ──────────────────────────────────────────
  incRequest(statusCode: number): void {
    this.reqCount++;
    if (statusCode >= 500) this.errCount++;
  }

  recordQuery(latencyMs: number): void {
    this.dbQueryCount++;
    this.dbQueryTotalMs += latencyMs;
    if (latencyMs > this.dbQueryMaxMs) this.dbQueryMaxMs = latencyMs;
  }

  // ── Snapshot ───────────────────────────────────────────────
  getTimeseries(windowSec?: number): MetricSample[] {
    if (!windowSec || windowSec <= 0) return this.buffer.slice();
    const cutoff = Date.now() - windowSec * 1000;
    return this.buffer.filter((p) => Date.parse(p.ts) >= cutoff);
  }

  /** Latest sample, or null if we haven't completed one yet. */
  latest(): MetricSample | null {
    return this.buffer.length === 0 ? null : this.buffer[this.buffer.length - 1]!;
  }

  // ── Internal ───────────────────────────────────────────────
  private sample(): void {
    const now = Date.now();
    const windowMs = Math.max(now - this.lastSampleTime, 1);

    // CPU: process.cpuUsage() delta. Both fields are microseconds.
    const cpu = process.cpuUsage(this.lastCpu);
    const cpuUsedMs = (cpu.user + cpu.system) / 1000;
    const cpuPct = (cpuUsedMs / windowMs) * 100;
    this.lastCpu = process.cpuUsage();

    const mem = process.memoryUsage();

    // Event loop — histogram is in nanoseconds; convert to ms.
    const eluNow = performance.eventLoopUtilization?.();
    let eluUtil = 0;
    if (eluNow && this.lastElu && performance.eventLoopUtilization) {
      const diff = performance.eventLoopUtilization(eluNow, this.lastElu);
      eluUtil = diff.utilization;
    }
    this.lastElu = eluNow ?? null;
    const eluMean = this.eluHistogram.mean / 1e6;
    const eluP99 = this.eluHistogram.percentile(99) / 1e6;
    this.eluHistogram.reset();

    const reqCount = this.reqCount;
    const errCount = this.errCount;
    const dbCount = this.dbQueryCount;
    const dbTotal = this.dbQueryTotalMs;
    const dbMax = this.dbQueryMaxMs;
    this.reqCount = 0;
    this.errCount = 0;
    this.dbQueryCount = 0;
    this.dbQueryTotalMs = 0;
    this.dbQueryMaxMs = 0;

    const windowSec = windowMs / 1000;
    const sample: MetricSample = {
      ts: new Date(now).toISOString(),
      cpu_pct: round(cpuPct, 2),
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      heap_total_bytes: mem.heapTotal,
      event_loop_mean_ms: round(eluMean, 2),
      event_loop_p99_ms: round(eluP99, 2),
      event_loop_util: round(eluUtil, 3),
      req_count: reqCount,
      req_rate: round(reqCount / windowSec, 2),
      err_count: errCount,
      err_rate: reqCount === 0 ? 0 : round(errCount / reqCount, 3),
      db_query_count: dbCount,
      db_query_rate: round(dbCount / windowSec, 2),
      db_query_mean_ms: dbCount === 0 ? 0 : round(dbTotal / dbCount, 2),
      db_query_max_ms: round(dbMax, 2),
    };

    this.buffer.push(sample);
    if (this.buffer.length > MAX_POINTS) {
      this.buffer.splice(0, this.buffer.length - MAX_POINTS);
    }
    this.lastSampleTime = now;
  }
}

function round(n: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(n * m) / m;
}

export const metricsRecorder = new MetricsRecorder();
