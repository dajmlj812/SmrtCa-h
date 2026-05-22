import pg from 'pg';
import { config } from '../config.js';

// --- Type parsers -----------------------------------------------------------
// int8 / bigint (oid 20): money is stored as integer cents, well within the
// safe-integer range, so return real numbers instead of strings.
pg.types.setTypeParser(20, (value) => parseInt(value, 10));
// date (oid 1082): keep the raw 'YYYY-MM-DD' string to avoid timezone shifts
// that occur when node-postgres builds a JS Date in the local zone.
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
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
