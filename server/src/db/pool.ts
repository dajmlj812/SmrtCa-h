import pg from 'pg';
import { config } from '../config.js';
import { metricsRecorder } from '../domain/metrics-recorder.js';
import { diagnosticsRecorder } from '../domain/diagnostics-recorder.js';

// --- Type parsers -----------------------------------------------------------
// int8 / bigint (oid 20): money is stored as integer cents, well within the
// safe-integer range, so return real numbers instead of strings.
pg.types.setTypeParser(20, (value) => parseInt(value, 10));
// date (oid 1082): keep the raw 'YYYY-MM-DD' string to avoid timezone shifts
// that occur when node-postgres builds a JS Date in the local zone.
pg.types.setTypeParser(1082, (value) => value);

// 0.18.13 — PG_POOL_MAX is settable via the Settings UI. Read at
// module load (= process boot). Default of 10 matches pg.Pool's
// built-in default. The setting is restart-required because the pool
// is built once and not reconfigured at runtime.
const poolMax = (() => {
  const raw = process.env.PG_POOL_MAX;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : undefined;
})();

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ...(poolMax !== undefined ? { max: poolMax } : {}),
});

/**
 * Instrumented query helper — every call here is timed and reported to
 * the metrics recorder, so /api/health/timeseries shows accurate DB
 * query rate + mean/max latency.
 *
 * Most of the server uses this helper or `withTransaction()` below
 * (which also threads instrumented calls through). The handful of
 * places that call `pool.query` directly aren't reported — that's a
 * pragmatic tradeoff to avoid wrapping the pg.Pool method itself,
 * which proved fragile against pg's overload typing.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const t0 = Date.now();
  try {
    return await pool.query<T>(text, params as unknown[]);
  } finally {
    const duration = Date.now() - t0;
    metricsRecorder.recordQuery(duration);
    // 0.18.13 — slow-query capture for /health. The recorder
    // gates by threshold internally so we don't filter here.
    diagnosticsRecorder.recordSlowQuery(text, params, duration);
  }
}

/** Run a function inside a single transaction, committing or rolling back. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
