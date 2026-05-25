import { getEffectiveValue } from './settings.js';
import {
  runPerformanceAnalysis,
  type PerformanceReport,
} from './performance-analyzer.js';

/**
 * 0.18.13 — scheduler that periodically reruns the performance
 * analyzer. The interval is read fresh from the
 * PERFORMANCE_ANALYSIS_INTERVAL_HOURS setting on every tick, so a
 * super-admin's change takes effect on the next firing (or at the
 * next tick of the existing schedule, whichever comes first).
 *
 * The latest report lives in-memory; on a restart, the first poll
 * shows "no analysis yet" until the boot-time run completes a few
 * seconds later. We deliberately don't persist the report —
 * recommendations are about the CURRENT state of the system, and
 * a stale report is less useful than no report.
 *
 * Manual override: the "Run now" button calls runManualAnalysis()
 * which updates the cached report immediately without disturbing
 * the next-scheduled-tick.
 */

const DEFAULT_INTERVAL_HOURS = 24;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168;
// Boot-time delay so we don't run the analyzer during the first few
// seconds of startup, when memory and DB stats are unrepresentative.
const STARTUP_DELAY_MS = 30_000;

let latestReport: PerformanceReport | null = null;
let nextScheduledAt: Date | null = null;
let scheduledTimer: NodeJS.Timeout | null = null;
let running = false;

export interface PerformanceSchedulerState {
  latest: PerformanceReport | null;
  next_scheduled_at: string | null;
  running: boolean;
  /** The interval the scheduler is currently using, in hours. */
  interval_hours: number;
}

export async function getCurrentIntervalHours(): Promise<number> {
  const raw = (await getEffectiveValue('PERFORMANCE_ANALYSIS_INTERVAL_HOURS')).trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_INTERVAL_HOURS || n > MAX_INTERVAL_HOURS) {
    return DEFAULT_INTERVAL_HOURS;
  }
  return n;
}

export function getSchedulerState(): PerformanceSchedulerState {
  return {
    latest: latestReport,
    next_scheduled_at: nextScheduledAt?.toISOString() ?? null,
    running,
    interval_hours: latestReport
      ? Math.round(
          (nextScheduledAt?.getTime() ?? 0 - new Date(latestReport.generated_at).getTime()) /
            3_600_000,
        ) || DEFAULT_INTERVAL_HOURS
      : DEFAULT_INTERVAL_HOURS,
  };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    latestReport = await runPerformanceAnalysis();
  } catch (err) {
    // The analyzer itself catches per-check failures; a failure at
    // THIS level means something fundamental broke (DB unreachable
    // etc.). Leave the previous report in place — that's still
    // useful — and try again next tick.
    console.error('[performance-scheduler] analyzer threw:', err);
  } finally {
    running = false;
  }
  await scheduleNext();
}

async function scheduleNext(): Promise<void> {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  const hours = await getCurrentIntervalHours();
  const ms = hours * 3_600_000;
  nextScheduledAt = new Date(Date.now() + ms);
  scheduledTimer = setTimeout(() => {
    void tick();
  }, ms);
  if (typeof scheduledTimer.unref === 'function') {
    scheduledTimer.unref();
  }
}

/**
 * Run the analyzer NOW (super-admin "Run now" click). Updates the
 * cached report. Does not disturb the next scheduled tick.
 */
export async function runManualAnalysis(): Promise<PerformanceReport> {
  if (running) {
    // Don't fire a parallel one; wait briefly and return whatever
    // the in-flight one produces.
    const start = Date.now();
    while (running && Date.now() - start < 30_000) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (latestReport) return latestReport;
  }
  running = true;
  try {
    latestReport = await runPerformanceAnalysis();
    return latestReport;
  } finally {
    running = false;
  }
}

/**
 * Start the scheduler. Called once from server bootstrap. Runs a
 * boot-time analysis after STARTUP_DELAY_MS so the in-memory metrics
 * have a chance to accumulate; subsequent ticks are on the
 * configured interval.
 */
export function startPerformanceScheduler(): void {
  if (scheduledTimer) return; // already started
  const firstTimer = setTimeout(() => {
    void tick();
  }, STARTUP_DELAY_MS);
  if (typeof firstTimer.unref === 'function') firstTimer.unref();
  nextScheduledAt = new Date(Date.now() + STARTUP_DELAY_MS);
}

export function stopPerformanceScheduler(): void {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer);
    scheduledTimer = null;
  }
  nextScheduledAt = null;
}
