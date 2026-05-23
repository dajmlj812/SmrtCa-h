import { pool } from '../db/pool.js';
import { getEffectiveValue } from './settings.js';
import {
  ofxDirectConnectSource,
  type OfxDirectConnectContext,
} from '../datasource/ofx-direct-connect.js';
import { fetchPlaidItemTransactions } from '../datasource/plaid.js';
import { OfxDcError } from './ofx-dc.js';
import { PlaidError, type FetchLike as PlaidFetch } from './plaid.js';
import { persistBatch } from '../import/importer.js';

/**
 * Phase 8.3 (0.11.3) — scheduled background sync.
 *
 * The same in-process scheduler shape as `backup-scheduler.ts`: a 60s
 * tick reads settings + walks every enabled source. The cadence gate
 * is PER-SOURCE (not global): each connection / item has its own
 * `last_sync_at`, and the cadence threshold determines whether this
 * source is "due" right now.
 *
 * Failures are isolated to one source — the route already updates
 * `last_sync_status` + `last_sync_error` on the row, and the tick
 * just moves on to the next source. One bad bank cannot block the
 * others.
 *
 * Manual /sync (per source) and this scheduler share the same data-
 * source modules + persistBatch path, so behavior is identical.
 */

const TICK_MS = 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export interface AutoSyncTickResult {
  enabled: boolean;
  frequency: string;
  ranAt: string;
  ofxDc: { attempted: number; succeeded: number; failed: number };
  plaid: { attempted: number; succeeded: number; failed: number };
}

export function startAutoSyncScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopAutoSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runAutoSyncTick();
  } catch {
    // Swallow scheduler errors so an unhandled rejection on the
    // interval doesn't crash the process. Per-source errors land on
    // the row's last_sync_error column.
  } finally {
    running = false;
  }
}

/**
 * Single tick — exported for the `/api/auto-sync/run` route and for
 * tests. Honors the settings gate; tests can also force a run by
 * setting `force: true`.
 */
export async function runAutoSyncTick(opts: {
  force?: boolean;
  ofxFetchOverride?: OfxDirectConnectContext['fetchImpl'];
  plaidFetchOverride?: PlaidFetch;
  now?: Date;
} = {}): Promise<AutoSyncTickResult> {
  const now = opts.now ?? new Date();
  const enabled =
    (await getEffectiveValue('AUTO_SYNC_ENABLED')).toLowerCase() === 'true';
  const frequency =
    (await getEffectiveValue('AUTO_SYNC_FREQUENCY')).toLowerCase() || 'daily';

  const result: AutoSyncTickResult = {
    enabled,
    frequency,
    ranAt: now.toISOString(),
    ofxDc: { attempted: 0, succeeded: 0, failed: 0 },
    plaid: { attempted: 0, succeeded: 0, failed: 0 },
  };
  if (!enabled && !opts.force) return result;

  // For daily/weekly cadence, only run after the configured HH:MM has
  // passed today — same gate as the backup scheduler. Unlike backups,
  // we additionally gate PER SOURCE on last_sync_at, so even if this
  // tick runs we still skip sources that already synced inside the
  // window.
  if (!opts.force && frequency !== 'hourly') {
    const timeStr = (await getEffectiveValue('AUTO_SYNC_TIME')) || '03:00';
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return result;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return result;
    const scheduledToday = new Date(now);
    scheduledToday.setHours(hh, mm, 0, 0);
    if (now < scheduledToday) return result;
  }

  // OFX-DC connections.
  const ofxRows = await pool.query<{
    id: string;
    tenant_id: string;
    account_id: string;
    name: string;
    last_sync_at: Date | null;
  }>(
    `SELECT id, tenant_id, account_id, name, last_sync_at
       FROM ofx_dc_connections
      WHERE enabled = true`,
  );
  for (const row of ofxRows.rows) {
    if (!opts.force && !shouldRunForSource(row.last_sync_at, frequency, now)) {
      continue;
    }
    result.ofxDc.attempted += 1;
    try {
      const fetched = await ofxDirectConnectSource.fetch({
        connectionId: row.id,
        tenantId: row.tenant_id,
        endDate: now,
        fetchImpl: opts.ofxFetchOverride,
      } as OfxDirectConnectContext);
      const persisted = await persistBatch(
        row.account_id,
        `auto-sync:ofx-dc:${row.name}`,
        'ofx_dc',
        fetched.transactions,
        fetched.errors,
      );
      await pool.query(
        `UPDATE ofx_dc_connections
            SET last_sync_at = $1,
                last_sync_status = 'ok',
                last_sync_error = NULL,
                last_sync_imported = $2,
                last_sync_skipped = $3,
                updated_at = now()
          WHERE id = $4`,
        [now, persisted.importedCount, persisted.skippedCount, row.id],
      );
      result.ofxDc.succeeded += 1;
    } catch (err) {
      const kind = err instanceof OfxDcError ? err.kind : 'transport_error';
      const message = err instanceof Error ? err.message : String(err);
      await pool.query(
        `UPDATE ofx_dc_connections
            SET last_sync_status = $1, last_sync_error = $2, updated_at = now()
          WHERE id = $3`,
        [kind, message, row.id],
      );
      result.ofxDc.failed += 1;
    }
  }

  // Plaid items. Plaid items don't have an `enabled` column — once
  // linked, they're live until DELETEd.
  const plaidRows = await pool.query<{
    id: string;
    tenant_id: string;
    last_sync_at: Date | null;
  }>(
    `SELECT id, tenant_id, last_sync_at FROM plaid_items WHERE status = 'active'`,
  );
  for (const row of plaidRows.rows) {
    if (!opts.force && !shouldRunForSource(row.last_sync_at, frequency, now)) {
      continue;
    }
    result.plaid.attempted += 1;
    try {
      const fetched = await fetchPlaidItemTransactions({
        plaidItemId: row.id,
        tenantId: row.tenant_id,
        fetchImpl: opts.plaidFetchOverride,
      });
      let totalImported = 0;
      let totalSkipped = 0;
      for (const [smrtAccountId, txns] of fetched.byAccount.entries()) {
        const persisted = await persistBatch(
          smrtAccountId,
          `auto-sync:plaid:${row.id}`,
          'plaid',
          txns,
          [],
        );
        totalImported += persisted.importedCount;
        totalSkipped += persisted.skippedCount;
      }
      await pool.query(
        `UPDATE plaid_items
            SET sync_cursor = $1,
                last_sync_at = $2,
                last_sync_status = 'ok',
                last_sync_error = NULL,
                last_sync_imported = $3,
                last_sync_skipped = $4,
                updated_at = now()
          WHERE id = $5`,
        [fetched.cursor, now, totalImported, totalSkipped, row.id],
      );
      result.plaid.succeeded += 1;
    } catch (err) {
      const kind = err instanceof PlaidError ? err.kind : 'transport_error';
      const message = err instanceof Error ? err.message : String(err);
      await pool.query(
        `UPDATE plaid_items
            SET last_sync_status = $1, last_sync_error = $2, updated_at = now()
          WHERE id = $3`,
        [kind, message, row.id],
      );
      result.plaid.failed += 1;
    }
  }

  return result;
}

/**
 * Per-source cadence gate. Sources whose `last_sync_at` is older than
 * the threshold are "due"; everything else is skipped this tick. A
 * NULL last_sync_at always returns true — a never-synced source
 * should run on the first qualifying tick.
 *
 * Thresholds are slightly under the cadence to tolerate jitter from
 * the 60s interval — the same trick the backup scheduler uses.
 */
export function shouldRunForSource(
  lastSyncAt: Date | null,
  frequency: string,
  now: Date,
): boolean {
  if (!lastSyncAt) return true;
  const diffMs = now.getTime() - lastSyncAt.getTime();
  switch (frequency) {
    case 'hourly':
      return diffMs >= 60 * 60 * 1000 - 60_000;
    case 'weekly':
      return diffMs >= 6 * 24 * 60 * 60 * 1000;
    case 'daily':
    default:
      return diffMs >= 23 * 60 * 60 * 1000;
  }
}
