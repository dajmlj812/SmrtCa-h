// Prepares the isolated `smrtcash_e2e` database BEFORE Playwright starts the
// API web server (the API needs the database to already exist). Also clears
// the e2e attachments directory. Runs as the `setup` step chained ahead of
// `playwright test`.
import pg from 'pg';
import { config as loadEnv } from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const baseUrl =
  process.env.DATABASE_URL ??
  'postgres://smrtcash:smrtcash_dev_pw@localhost:5432/smrtcash';
const dbUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, '/smrtcash_e2e$1');
const dbName = new URL(dbUrl).pathname.slice(1);
const adminUrl = dbUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const migrationsDir = fileURLToPath(
  new URL('../server/src/db/migrations', import.meta.url),
);

async function ensureDatabase() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${dbName}`);
      console.log(`Created database ${dbName}`);
    }
  } finally {
    await admin.end();
  }
}

async function migrateAndReset() {
  const pool = new pg.Pool({ connectionString: dbUrl });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const applied = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    );
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(`${migrationsDir}/${file}`, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    // Start every e2e run from a clean slate.
    await client.query(
      'TRUNCATE accounts, categories, import_batches, transactions, attachments RESTART IDENTITY CASCADE',
    );
  } finally {
    client.release();
    await pool.end();
  }
}

await ensureDatabase();
await migrateAndReset();

// Clean the e2e attachments directory so every run starts with no files.
const e2eAttachmentsDir = join(tmpdir(), 'smrtcash-e2e-attachments');
await rm(e2eAttachmentsDir, { recursive: true, force: true });

console.log(`e2e database "${dbName}" is ready and clean.`);
console.log(`e2e attachments dir cleared: ${e2eAttachmentsDir}`);
