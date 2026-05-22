import pg from 'pg';
import { applyMigrations } from '../../src/db/migrate-runner.js';

/**
 * Vitest global setup — runs once before the whole suite.
 * Ensures the isolated `smrtcash_test` database exists and is migrated.
 */
export default async function globalSetup(): Promise<void> {
  const testUrl = process.env.DATABASE_URL;
  if (!testUrl) throw new Error('DATABASE_URL is not set for tests');

  const dbName = new URL(testUrl).pathname.slice(1);
  // Maintenance connection to the always-present "postgres" database.
  const adminUrl = testUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1');

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${dbName}`);
    }
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: testUrl });
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
  }
}
