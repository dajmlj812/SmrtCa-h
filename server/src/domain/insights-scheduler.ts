import { pool, query } from '../db/pool.js';
import { generateInsights } from './insights-generator.js';
import { sweepOverdueBills } from './bill-matcher.js';

/**
 * 0.20.0 — daily insight-card scanner.
 *
 * Walks every tenant once per 24h, generates proposed cards via
 * insights-generator, and inserts the new ones (skipping any that
 * collide with an existing open card on the (tenant, kind,
 * source_id) unique index).
 *
 * Also prunes dismissed cards older than 30 days to keep the
 * table small — the audit shape was never the point of this
 * table; it's a transient surface.
 *
 * Scheduling: tick every hour. Each tenant's last-run timestamp
 * is stored in app_settings (key: insight_scan_last_run_<tenant>).
 * The scheduler skips tenants scanned in the last 23h, so we don't
 * pile up cards if the loop ticks early.
 */

const TICK_MS = 60 * 60 * 1000; // 1 hour
const MIN_INTERVAL_HOURS = 23;
const PRUNE_AFTER_DAYS = 30;

let timer: ReturnType<typeof setInterval> | null = null;

export function startInsightsScheduler(): void {
  if (timer) return;
  // Stagger first run ~60s after boot so it doesn't compete with
  // the rest of startup.
  setTimeout(() => void tick(), 60 * 1000);
  timer = setInterval(() => void tick(), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopInsightsScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  try {
    await pruneOldDismissedCards();
    // 0.22.0 — sweep past-due bills BEFORE the per-tenant
    // insights generator, so any bill_overdue cards land in the
    // same scan window the user sees on their dashboard. Sweep
    // is whole-fleet (one query); safe to re-run.
    try {
      const today = new Date().toISOString().slice(0, 10);
      await sweepOverdueBills(today);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        'insights-scheduler: overdue sweep failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    const tenants = await query<{ id: string }>(`SELECT id FROM tenants`);
    for (const t of tenants.rows) {
      try {
        await runForTenant(t.id);
      } catch (err) {
        // Per-tenant failure shouldn't take down the whole tick.
        // eslint-disable-next-line no-console
        console.error(
          `insights-scheduler: failed for tenant ${t.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      'insights-scheduler tick failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function runForTenant(tenantId: string): Promise<void> {
  // Skip if scanned recently. Last-run is stored as a row in a
  // dedicated table; we keep this out of app_settings because the
  // latter is operator-facing and would be confusing with per-
  // tenant timestamps.
  const last = await query<{ last_run_at: string | null }>(
    `SELECT MAX(created_at)::text AS last_run_at FROM insight_cards WHERE tenant_id = $1`,
    [tenantId],
  );
  const lastRun = last.rows[0]?.last_run_at
    ? new Date(last.rows[0].last_run_at).getTime()
    : 0;
  const hoursSince = (Date.now() - lastRun) / (3600 * 1000);
  if (lastRun > 0 && hoursSince < MIN_INTERVAL_HOURS) return;

  await generateAndPersist(tenantId);
}

/**
 * Public helper for the on-demand "regenerate now" route. Skips
 * the time-since-last-run gate so the operator can force a fresh
 * scan from the UI.
 */
export async function generateAndPersist(
  tenantId: string,
): Promise<{ generated: number; skipped_dupes: number }> {
  const proposed = await generateInsights(tenantId);
  let generated = 0;
  let skipped = 0;
  for (const c of proposed) {
    try {
      // ON CONFLICT target must spell out the partial-index
      // predicate exactly — Postgres won't match a bare
      // `ON CONFLICT DO NOTHING` against a partial unique index.
      // For cards without a source_id (which fall outside the
      // partial index's WHERE clause), we skip the dedupe path
      // entirely and just insert; those kinds always go through
      // the in-generator volume cap.
      const sql =
        c.source_id !== undefined && c.source_id !== null
          ? `INSERT INTO insight_cards
               (tenant_id, kind, severity, title, body, action_label, action_url, source_kind, source_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (tenant_id, kind, source_id)
               WHERE dismissed_at IS NULL AND source_id IS NOT NULL
             DO NOTHING`
          : `INSERT INTO insight_cards
               (tenant_id, kind, severity, title, body, action_label, action_url, source_kind, source_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
      const r = await query(sql, [
        tenantId,
        c.kind,
        c.severity,
        c.title,
        c.body,
        c.action_label ?? null,
        c.action_url ?? null,
        c.source_kind ?? null,
        c.source_id ?? null,
      ]);
      if (r.rowCount && r.rowCount > 0) generated++;
      else skipped++;
    } catch (err) {
      // Unique-violation on a NULL source_id (the partial index
      // doesn't cover those, but our migration's CHECK + business
      // logic means we shouldn't hit this). Log + continue.
      // eslint-disable-next-line no-console
      console.error(
        'insights-scheduler: insert failed:',
        err instanceof Error ? err.message : String(err),
      );
      skipped++;
    }
  }
  return { generated, skipped_dupes: skipped };
}

async function pruneOldDismissedCards(): Promise<void> {
  await query(
    `DELETE FROM insight_cards
      WHERE dismissed_at IS NOT NULL
        AND dismissed_at < now() - make_interval(days => $1)`,
    [PRUNE_AFTER_DAYS],
  );
}
