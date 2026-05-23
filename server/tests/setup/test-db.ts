import type { FastifyInstance, InjectOptions } from 'fastify';
import { rm } from 'node:fs/promises';
import { buildApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { pool } from '../../src/db/pool.js';
import { seedDefaultCategories } from '../../src/domain/categories.js';

// Fixed identifiers — keeping the user + session UUIDs stable across reset
// cycles lets the cookie keep working without rewriting it every beforeEach.
const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_SESSION_ID = 'test-session-fixed-deterministic-id-9z4q';
// Placeholder hash — `/api/auth/login` would fail against it, but the test
// session is inserted directly so verify() is never called. Tests that
// exercise login use resetDb({ skipAuth: true }) and create real users.
const TEST_PASSWORD_HASH = '$argon2id$placeholder-not-a-real-hash';

let cachedAuthCookie: string | null = null;

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
 *
 * Also seeds a fixed test user + session so every existing test continues
 * to authenticate transparently. Pass `{ skipAuth: true }` from auth tests
 * that need to start from a clean unauthenticated state.
 */
export async function resetDb(opts: { skipAuth?: boolean } = {}): Promise<void> {
  await pool.query(
    `TRUNCATE accounts, categories, import_batches, transactions, attachments,
              users, sessions, budgets, savings_goals, bills, recurring_income
       RESTART IDENTITY CASCADE`,
  );
  await seedDefaultCategories(pool);
  if (!opts.skipAuth) {
    await pool.query(
      `INSERT INTO users (id, password_hash) VALUES ($1, $2)`,
      [TEST_USER_ID, TEST_PASSWORD_HASH],
    );
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at)
       VALUES ($1, $2, now() + interval '1 day')`,
      [TEST_SESSION_ID, TEST_USER_ID],
    );
  }
}

/**
 * Build a test instance of the API. The returned app's `inject()` is
 * wrapped to auto-attach the test session cookie unless the caller passes
 * `skipAuth: true` in the inject options — so every existing test that
 * hit a private route continues to work without edits.
 */
export async function makeTestApp(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: false });
  cachedAuthCookie = `smrtcash_session=${app.signCookie(TEST_SESSION_ID)}`;
  const origInject = app.inject.bind(app);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).inject = (opts: InjectOptions & { skipAuth?: boolean }) => {
    if (!opts.skipAuth && cachedAuthCookie) {
      const existing = (opts.headers ?? {}) as Record<string, unknown>;
      const hasCookie =
        Object.keys(existing).some((k) => k.toLowerCase() === 'cookie');
      if (!hasCookie) {
        opts.headers = { ...existing, cookie: cachedAuthCookie };
      }
    }
    const { skipAuth: _drop, ...passthrough } = opts;
    void _drop;
    return origInject(passthrough);
  };
  return app;
}

/** Cookie value matching the seeded test session — for tests that want to
 *  attach it explicitly (e.g. when sending a FormData request that needs
 *  custom headers anyway). */
export function testAuthCookie(): string {
  if (!cachedAuthCookie) {
    throw new Error('makeTestApp() must be called before testAuthCookie()');
  }
  return cachedAuthCookie;
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
