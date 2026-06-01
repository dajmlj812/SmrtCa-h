import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  makeSuperAdminCookie,
  makeTestApp,
  pool,
  resetDb,
  seedAccount,
} from '../setup/test-db.js';

// Health + backups + the SMTP test endpoint moved to super-admin only
// in 0.9.1. Tests in those describe blocks build a one-shot
// super-admin session and pass it explicitly via the cookie header.
function asSuper(cookie: string) {
  return { headers: { cookie }, skipAuth: true };
}

async function seedTxn(opts: {
  accountId: string;
  date: string;
  amountCents: number;
  merchant?: string;
}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash,
        normalized_merchant)
     VALUES ($1, $2, $3, $4, $5, $4)
     RETURNING id`,
    [
      opts.accountId,
      opts.date,
      opts.amountCents,
      opts.merchant ?? 'TEST',
      randomUUID(),
    ],
  );
  return r.rows[0]!.id;
}

describe('Health metrics (Phase 7.6, super-admin gated 0.9.1)', () => {
  let app: FastifyInstance;
  let superCookie: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    superCookie = await makeSuperAdminCookie(app);
  });

  it('tenant admin gets 403 on /api/health/metrics', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health/metrics' });
    expect(r.statusCode).toBe(403);
  });

  it('returns app + db + storage sections to a super admin', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/health/metrics',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.app).toBeDefined();
    expect(body.app.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(body.app.node_version).toMatch(/^v\d+/);
    expect(body.app.heap_size_limit_bytes).toBeGreaterThan(
      body.app.heap_used_bytes,
    );
    expect(body.db).toBeDefined();
    expect(body.db.connected).toBe(true);
    expect(body.db.ping_ms).toBeGreaterThanOrEqual(0);
    expect(body.db.table_counts).toBeDefined();
    expect(body.db.last_migration).toMatch(/\.sql$/);
    expect(body.storage).toBeDefined();
  });

  it('table_counts reflect newly inserted rows', async () => {
    const acct = await seedAccount();
    await seedTxn({ accountId: acct, date: '2026-05-01', amountCents: -123 });
    await seedTxn({ accountId: acct, date: '2026-05-02', amountCents: -456 });
    const r = await app.inject({
      method: 'GET',
      url: '/api/health/metrics',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    const body = r.json();
    expect(body.db.table_counts.accounts).toBe(1);
    expect(body.db.table_counts.transactions).toBe(2);
  });

  it('GET /api/health/timeseries returns the buffer envelope', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/health/timeseries?window=60',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.window_seconds).toBe(60);
    expect(Array.isArray(body.points)).toBe(true);
    for (const p of body.points) {
      expect(typeof p.ts).toBe('string');
      expect(typeof p.cpu_pct).toBe('number');
      expect(typeof p.rss_bytes).toBe('number');
      expect(typeof p.req_rate).toBe('number');
      expect(typeof p.db_query_rate).toBe('number');
    }
  });

  it('GET /api/health/live returns the most recent sample or null', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/health/live',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    if (body.latest !== null) {
      expect(typeof body.latest.ts).toBe('string');
      expect(typeof body.latest.cpu_pct).toBe('number');
    }
  });

  // ── 0.15.5: SaaS health endpoint ───────────────────────────

  it('tenant admin gets 403 on /api/health/saas', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health/saas' });
    expect(r.statusCode).toBe(403);
  });

  it('GET /api/health/saas returns tenants/subscriptions/webhooks shape', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/health/saas',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    // resetDb seeds a Default tenant + a Family active sub.
    expect(body.tenants.total).toBeGreaterThanOrEqual(1);
    expect(body.tenants.with_active_sub).toBeGreaterThanOrEqual(1);
    expect(body.subscriptions.total).toBeGreaterThanOrEqual(1);
    expect(body.subscriptions.by_plan).toEqual(
      expect.objectContaining({ starter: expect.any(Number), plus: expect.any(Number), family: expect.any(Number) }),
    );
    expect(body.subscriptions.by_status).toBeDefined();
    expect(body.webhooks.processed_total).toBeGreaterThanOrEqual(0);
    expect(body.webhooks.processed_24h).toBeGreaterThanOrEqual(0);
  });

  it('webhook counts reflect newly recorded events', async () => {
    // stripe_processed_events is intentionally NOT truncated by resetDb
    // (it's the Stripe idempotency ledger and is meant to be monotonic).
    // That means rows from a previous run of THIS test survive, and an
    // `ON CONFLICT DO NOTHING` re-insert keeps their original, now-stale
    // processed_at — which makes the processed_24h window read 0. Clear
    // our own fixture ids first so each run records fresh timestamps.
    await pool.query(
      `DELETE FROM stripe_processed_events
        WHERE event_id IN ('evt_test_a', 'evt_test_b', 'evt_test_c')`,
    );
    await pool.query(
      `INSERT INTO stripe_processed_events (event_id) VALUES
         ('evt_test_a'), ('evt_test_b'), ('evt_test_c')`,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/api/health/saas',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    const body = r.json();
    expect(body.webhooks.processed_total).toBeGreaterThanOrEqual(3);
    expect(body.webhooks.processed_24h).toBeGreaterThanOrEqual(3);
    expect(body.webhooks.last_event_at).not.toBeNull();
  });
});

describe('Backups (Phase 7.6, super-admin gated 0.9.1)', () => {
  let app: FastifyInstance;
  let superCookie: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    superCookie = await makeSuperAdminCookie(app);
  });

  it('tenant admin gets 403 on /api/backups', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/backups' });
    expect(r.statusCode).toBe(403);
  });

  it('GET /api/backups returns an empty list initially', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/backups',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().backups).toEqual([]);
  });

  it('GET /api/backups/config returns defaults when nothing is set', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/backups/config',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.enabled).toBe(false);
    expect(body.frequency).toBe('daily');
    expect(body.time).toBe('03:00');
    expect(body.retention_days).toBe(30);
    expect(typeof body.resolved_directory).toBe('string');
  });

  it('GET /api/backups/config reflects PUT /api/settings updates', async () => {
    // BACKUP_* keys are now super-only — write via the super cookie.
    await app.inject({
      method: 'PUT',
      url: '/api/settings/BACKUP_ENABLED',
      payload: { value: 'true' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    await app.inject({
      method: 'PUT',
      url: '/api/settings/BACKUP_FREQUENCY',
      payload: { value: 'weekly' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    const r = await app.inject({
      method: 'GET',
      url: '/api/backups/config',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.json().enabled).toBe(true);
    expect(r.json().frequency).toBe('weekly');
  });

  it('lists only non-deleted backups', async () => {
    await pool.query(
      `INSERT INTO backups (kind, status, path, db_bytes, total_bytes)
       VALUES ('manual', 'success', '/tmp/x1', 100, 100),
              ('manual', 'deleted', '/tmp/x2', 200, 200)`,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/api/backups',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.json().backups).toHaveLength(1);
    expect(r.json().backups[0].path).toBe('/tmp/x1');
  });

  it('DELETE /api/backups/:id marks the row deleted', async () => {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO backups (kind, status, path, total_bytes)
       VALUES ('manual', 'success', '/tmp/no-such-path-${randomUUID()}', 100)
       RETURNING id`,
    );
    const id = ins.rows[0]!.id;
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/backups/${id}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(204);

    const after = await pool.query<{ status: string }>(
      `SELECT status FROM backups WHERE id = $1`,
      [id],
    );
    expect(after.rows[0]!.status).toBe('deleted');
  });

  it('rejects DELETE for a malformed id', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/backups/not-a-uuid',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('Reports (Phase 7.6)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('GET /api/reports lists the canned report set', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/reports' });
    expect(r.statusCode).toBe(200);
    const ids = r.json().reports.map((x: { id: string }) => x.id);
    expect(ids).toContain('spending-by-category');
    expect(ids).toContain('top-merchants');
    expect(ids).toContain('monthly-income-expense');
    expect(ids).toContain('subscription-costs');
    expect(ids).toContain('largest-transactions');
    expect(ids).toContain('net-worth-by-month');
  });

  it('runs spending-by-category and respects the date range', async () => {
    const acct = await seedAccount();
    const cat = await pool.query<{ id: string }>(
      `SELECT id FROM categories WHERE name = 'Groceries' LIMIT 1`,
    );
    const catId = cat.rows[0]!.id;
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash, category_id)
       VALUES ($1, '2026-05-01', -5000, 'KROGER', $2, $3),
              ($1, '2026-05-02', -3500, 'KROGER', $4, $3),
              ($1, '2020-01-01', -9999, 'OLD',    $5, $3)`,
      [acct, randomUUID(), catId, randomUUID(), randomUUID()],
    );
    const r = await app.inject({
      method: 'POST',
      url: '/api/reports/spending-by-category/run',
      payload: { start: '2026-05-01', end: '2026-05-31' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const result = r.json().result;
    expect(result.rows[0]!.category_name).toBe('Groceries');
    expect(result.rows[0]!.total_cents).toBe(-8500);
  });

  it('returns 404 for an unknown report id', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/reports/no-such-report/run',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('subscription-costs returns active recurring bills with annualized cost', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'Streaming',
        amountCents: 1500,
        frequency: 'monthly',
        nextDueDate: '2026-06-01',
      },
      headers: { 'content-type': 'application/json' },
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/reports/subscription-costs/run',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(r.json().result.rows).toHaveLength(1);
    expect(r.json().result.rows[0].name).toBe('Streaming');
    expect(r.json().result.rows[0].annual_cents).toBe(-18000);
  });
});
