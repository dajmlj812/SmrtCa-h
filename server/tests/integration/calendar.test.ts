import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';

/**
 * Phase 9.3 (0.12.3) — calendar month endpoint.
 *
 * Aggregates spend / income / txn count per day plus bill-due
 * markers within a calendar month. Read-only.
 */

async function tenantId(): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
  return r.rows[0]!.id;
}

describe('GET /api/calendar/:month (0.12.3)', () => {
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

  it('rejects a bad month format', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/calendar/2026-bad' });
    expect(r.statusCode).toBe(400);
  });

  it('returns a fully-populated month with 31 days for May', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/calendar/2026-05' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.year).toBe(2026);
    expect(body.month).toBe(5);
    expect(body.daysInMonth).toBe(31);
    expect(body.days).toHaveLength(31);
    expect(body.days[0].date).toBe('2026-05-01');
    expect(body.days[30].date).toBe('2026-05-31');
  });

  it('handles February correctly (28 vs 29 day)', async () => {
    const r2026 = await app.inject({ method: 'GET', url: '/api/calendar/2026-02' });
    expect(r2026.json().daysInMonth).toBe(28);
    const r2028 = await app.inject({ method: 'GET', url: '/api/calendar/2028-02' });
    expect(r2028.json().daysInMonth).toBe(29);
  });

  it('aggregates per-day spend + income from transactions', async () => {
    const accountId = await seedAccount();
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES
         ($1, '2026-05-10', -2500, 'Coffee',    'cal-a'),
         ($1, '2026-05-10', -1200, 'Lunch',     'cal-b'),
         ($1, '2026-05-15',  5000, 'Refund',    'cal-c'),
         ($1, '2026-05-31', -9999, 'Last day',  'cal-d'),
         -- Bleed-over guards: APR + JUN transactions MUST NOT appear in May.
         ($1, '2026-04-30', -7777, 'Apr 30',    'cal-e'),
         ($1, '2026-06-01', -8888, 'Jun 1',     'cal-f')`,
      [accountId],
    );

    const r = await app.inject({ method: 'GET', url: '/api/calendar/2026-05' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const day = (d: string) =>
      (body.days as Array<{
        date: string;
        spend_cents: number;
        income_cents: number;
        txn_count: number;
      }>).find((x) => x.date === d)!;
    expect(day('2026-05-10').spend_cents).toBe(3700);
    expect(day('2026-05-10').txn_count).toBe(2);
    expect(day('2026-05-15').income_cents).toBe(5000);
    expect(day('2026-05-31').spend_cents).toBe(9999);
    expect(day('2026-05-01').txn_count).toBe(0);
    // Month-boundary guards.
    expect(body.totals.spend_cents).toBe(3700 + 9999);
    expect(body.totals.income_cents).toBe(5000);
  });

  it('marks bill-due days and surfaces upcoming bills', async () => {
    const tid = await tenantId();
    const b1 = await pool.query<{ id: string }>(
      `INSERT INTO bills (tenant_id, name, amount_cents, frequency, next_due_date)
       VALUES ($1, 'Rent', 200000, 'monthly', '2026-05-01') RETURNING id`,
      [tid],
    );
    const b2 = await pool.query<{ id: string }>(
      `INSERT INTO bills (tenant_id, name, amount_cents, frequency, next_due_date)
       VALUES ($1, 'Netflix', 1599, 'monthly', '2026-05-15') RETURNING id`,
      [tid],
    );
    const r = await app.inject({ method: 'GET', url: '/api/calendar/2026-05' });
    const body = r.json();
    // The calendar day exposes `bills_due` as an array of bill objects
    // ({ id, name, amount_cents }), not a bare id list.
    type CalDay = { date: string; bills_due: Array<{ id: string }> };
    const may1 = (body.days as CalDay[]).find((d) => d.date === '2026-05-01')!;
    expect(may1.bills_due.map((b) => b.id)).toContain(b1.rows[0]!.id);
    const may15 = (body.days as CalDay[]).find((d) => d.date === '2026-05-15')!;
    expect(may15.bills_due.map((b) => b.id)).toContain(b2.rows[0]!.id);
  });

  it('totals.budget_cents sums every budget row for the month', async () => {
    const tid = await tenantId();
    // Need a category id to attach a budget.
    const cat = await pool.query<{ id: string }>(
      `INSERT INTO categories (tenant_id, name) VALUES ($1, 'Food') RETURNING id`,
      [tid],
    );
    await pool.query(
      `INSERT INTO budgets (tenant_id, period_month, category_id, amount_cents)
       VALUES ($1, '2026-05-01', $2, 50000),
              ($1, '2026-05-01', NULL, 100000)`,
      [tid, cat.rows[0]!.id],
    );
    const r = await app.inject({ method: 'GET', url: '/api/calendar/2026-05' });
    expect(r.json().totals.budget_cents).toBe(150000);
  });

  it('tenant isolation — accounts in another tenant don\'t leak', async () => {
    // Seed a transaction under another tenant; the default tenant's
    // calendar must not see it.
    const other = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Other', 'other') RETURNING id`,
    );
    const otherAcct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (tenant_id, name, type, institution)
       VALUES ($1, 'Hidden', 'checking', 'Bank') RETURNING id`,
      [other.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-05-10', -99999, 'Hidden', 'cal-hidden')`,
      [otherAcct.rows[0]!.id],
    );
    const r = await app.inject({ method: 'GET', url: '/api/calendar/2026-05' });
    expect(r.json().totals.spend_cents).toBe(0);
  });
});
