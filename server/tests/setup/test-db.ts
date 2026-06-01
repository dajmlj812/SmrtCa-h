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
  // Migration 051 (security audit F-32) installs a BEFORE TRUNCATE trigger
  // that makes audit_log immutable in production. The test reset still needs
  // to clear it between tests, so we suppress user triggers for the TRUNCATE
  // via `session_replication_role = replica` — which disables them for THIS
  // SESSION ONLY and takes no table lock (unlike ALTER TABLE ... DISABLE
  // TRIGGER, which is global DDL under an ACCESS EXCLUSIVE lock and serializes
  // the whole suite). Both the SET and the TRUNCATE must run on the same
  // physical connection, so we check out one dedicated client rather than
  // using `pool.query` (which may route each call to a different connection,
  // leaving the TRUNCATE on a session where the role was never set).
  const client = await pool.connect();
  try {
    await client.query(`SET session_replication_role = 'replica'`);
    await client.query(
      `TRUNCATE accounts, categories, import_batches, transactions, attachments,
                users, sessions, budgets, savings_goals, bills, recurring_income,
                recurring_suggestions, normalization_rules, transaction_splits,
                holdings, vehicles, commute_routes, route_vehicle_assignments,
                fuel_prices, app_settings, backups, tenants, memberships,
                invitations, user_identities, auth_provider_configs,
                account_user_access, audit_log, exchange_rates,
                retirement_projections, ofx_dc_connections,
                plaid_items, plaid_account_links,
                split_participants, transaction_shares,
                anomaly_alerts, tenant_encryption_keys
         RESTART IDENTITY CASCADE`,
    );
  } finally {
    // Restore default trigger behavior before returning the connection to the
    // pool, so a later borrower of this same connection isn't silently running
    // with FK/user triggers disabled.
    try {
      await client.query(`SET session_replication_role = 'origin'`);
    } finally {
      client.release();
    }
  }
  await seedDefaultCategories(pool);
  if (!opts.skipAuth) {
    // Seed the singleton test user, the Default tenant, and a
    // membership so private-route tests pass through the auth gate
    // and (post-Phase 8) carry tenant context.
    await pool.query(
      `INSERT INTO users (id, email, name, password_hash)
       VALUES ($1, $2, 'Test User', $3)`,
      [TEST_USER_ID, 'test@local', TEST_PASSWORD_HASH],
    );
    const tenant = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Default', 'default')
         RETURNING id`,
    );
    const tenantId = tenant.rows[0]!.id;
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [tenantId, TEST_USER_ID],
    );
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
       VALUES ($1::uuid, 'local', $1::text, 'test@local')`,
      [TEST_USER_ID],
    );
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at, active_tenant_id)
       VALUES ($1, $2, now() + interval '1 day', $3)`,
      [TEST_SESSION_ID, TEST_USER_ID, tenantId],
    );
    // 0.15.2: every gated premium route requires an active
    // subscription on the caller's tenant. The default test setup
    // grants Family/active so existing tests (which don't care
    // about entitlements) keep working as written. Entitlement-
    // specific tests in tests/security/entitlements.test.ts
    // override the row to exercise Starter/quota-exhausted paths.
    await pool.query(
      `INSERT INTO subscriptions
         (tenant_id, plan_id, status, current_period_end)
       VALUES ($1, 'family', 'active', now() + interval '1 year')`,
      [tenantId],
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

/**
 * Create a fresh super-admin user + session for tests that exercise
 * super-only endpoints (/api/system/*, /api/health/*, /api/backups/*,
 * the SMTP test, and the super-only setting keys). Returns the cookie
 * value to attach via `headers: { cookie }`.
 *
 * Use `skipAuth: true` on the inject call so the auto-attached tenant
 * cookie doesn't override it.
 */
export async function makeSuperAdminCookie(
  app: FastifyInstance,
  email = `super-${Date.now()}@local`,
): Promise<string> {
  const userRes = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, is_super_admin)
     VALUES ($1, 'Super', 'placeholder', true)
     RETURNING id`,
    [email],
  );
  const userId = userRes.rows[0]!.id;
  const sessionId = `super-test-${userId.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at, active_tenant_id)
     VALUES ($1, $2, now() + interval '1 hour', NULL)`,
    [sessionId, userId],
  );
  return `smrtcash_session=${app.signCookie(sessionId)}`;
}

/** Insert an account directly and return its id (test helper).
 *  Defaults to the seeded Default tenant so tenant-scoped queries
 *  (Phase 9.1 assistant tools, etc.) see it. Pass tenantId: null
 *  to explicitly leave it orphaned. */
export async function seedAccount(
  overrides: Partial<{
    name: string;
    institution: string;
    type: string;
    last4: string;
    tenantId: string | null;
  }> = {},
): Promise<string> {
  let tenantId: string | null = overrides.tenantId ?? null;
  if (tenantId === null && overrides.tenantId === undefined) {
    const t = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
    );
    tenantId = t.rows[0]?.id ?? null;
  }
  const result = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, institution, type, last4, tenant_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      overrides.name ?? 'Test Account',
      overrides.institution ?? 'Test Bank',
      overrides.type ?? 'checking',
      overrides.last4 ?? '0000',
      tenantId,
    ],
  );
  return result.rows[0]!.id;
}

export { pool };
