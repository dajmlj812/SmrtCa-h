import type { FastifyInstance } from 'fastify';
import { rm } from 'node:fs/promises';
import { buildApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { pool } from '../../src/db/pool.js';
import { seedDefaultCategories } from '../../src/domain/categories.js';

// Safety net: tests TRUNCATE tables, so abort immediately if anything has
// pointed the suite at something other than the dedicated test database.
if (!/_test(\?|$)/.test(config.databaseUrl)) {
  throw new Error(
    `Refusing to run tests against a non-test database: ${config.databaseUrl}`,
  );
}
// Same kind of safety net for attachments: refuse to clean a path that
// doesn't look like a test directory.
if (!/test/i.test(config.attachmentsDir)) {
  throw new Error(
    `Refusing to run tests with non-test attachments dir: ${config.attachmentsDir}`,
  );
}

/** Wipe the on-disk attachments root used by tests. */
export async function cleanupAttachmentDir(): Promise<void> {
  await rm(config.attachmentsDir, { recursive: true, force: true });
}

/**
 * Remove all data (schema is kept) and re-seed the default category
 * taxonomy. Call in `beforeEach` for isolation.
 */
export async function resetDb(): Promise<void> {
  await pool.query(
    'TRUNCATE accounts, categories, import_batches, transactions, attachments RESTART IDENTITY CASCADE',
  );
  await seedDefaultCategories(pool);
}

/** Build a test instance of the API — no network listener, no logging. */
export async function makeTestApp(): Promise<FastifyInstance> {
  return buildApp({ logger: false });
}

/** Insert an account directly and return its id (test helper). */
export async function seedAccount(
  overrides: Partial<{
    name: string;
    institution: string;
    type: string;
    last4: string;
  }> = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, institution, type, last4)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      overrides.name ?? 'Test Account',
      overrides.institution ?? 'Test Bank',
      overrides.type ?? 'checking',
      overrides.last4 ?? '0000',
    ],
  );
  return result.rows[0]!.id;
}

export { pool };
