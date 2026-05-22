import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type pg from 'pg';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/**
 * Apply every pending SQL migration to the given pool, in filename order.
 * Idempotent — already-applied files (tracked in `schema_migrations`) are
 * skipped. Each migration runs in its own transaction. Returns the number
 * of migrations newly applied.
 */
export async function applyMigrations(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const applied = new Set(
      (
        await client.query<{ filename: string }>(
          'SELECT filename FROM schema_migrations',
        )
      ).rows.map((r) => r.filename),
    );

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    return count;
  } finally {
    client.release();
  }
}
