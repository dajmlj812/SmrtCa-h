import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, pool, resetDb, seedAccount } from '../setup/test-db.js';

describe('AutoMagic budget wizard', () => {
  let app: FastifyInstance;
  let accountId: string;
  let groceries: string;
  let gasFuel: string;
  let tolls: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    accountId = await seedAccount();
    const cats = await pool.query<{ name: string; id: string }>(
      `SELECT lower(name) AS name, id FROM categories
        WHERE lower(name) IN ('groceries', 'gas & fuel', 'tolls')`,
    );
    groceries = cats.rows.find((r) => r.name === 'groceries')!.id;
    gasFuel = cats.rows.find((r) => r.name === 'gas & fuel')!.id;
    tolls = cats.rows.find((r) => r.name === 'tolls')!.id;
  });

  it('preview returns N periods with income + bill instances and zeroed editable defaults when no history', async () => {
    // Seed one bill due each month + one biweekly income.
    await app.inject({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'Internet',
        amountCents: 8000,
        frequency: 'monthly',
        nextDueDate: '2026-06-15',
      },
      headers: { 'content-type': 'application/json' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/recurring-income',
      payload: {
        name: 'Payroll',
        amountCents: 200000,
        frequency: 'biweekly',
        nextExpectedDate: '2026-06-05',
      },
      headers: { 'content-type': 'application/json' },
    });

    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/preview',
      payload: {
        periodType: 'monthly',
        anchor: '2026-06-01',
        count: 3,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const preview = r.json().preview;
    expect(preview.periods).toHaveLength(3);
    // First period covers June — the $80 Internet bill due 6/15 should appear.
    const june = preview.periods[0];
    expect(june.bills).toHaveLength(1);
    expect(june.bills[0].name).toBe('Internet');
    expect(june.bills[0].amount_cents).toBe(8000);
    // Biweekly payroll → roughly 2 instances per month.
    expect(june.income.length).toBeGreaterThanOrEqual(2);
    // No groceries history → default of 0.
    expect(preview.groceriesWeeklyMedianCents).toBe(0);
    expect(june.groceriesCents).toBe(0);
  });

  it('preview uses last 8 weeks of Groceries transactions to pre-fill', async () => {
    // 4 weeks ago — $50; 3 weeks — $60; 2 weeks — $45; 1 week — $55.
    const today = new Date();
    const ago = (weeks: number) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - weeks * 7);
      return d.toISOString().slice(0, 10);
    };
    for (const [w, cents] of [
      [4, -5000],
      [3, -6000],
      [2, -4500],
      [1, -5500],
    ] as const) {
      await pool.query(
        `INSERT INTO transactions
           (account_id, txn_date, amount_cents, raw_description, dedup_hash, category_id)
         VALUES ($1, $2, $3, 'GROC', $4, $5)`,
        [accountId, ago(w), cents, randomUUID(), groceries],
      );
    }

    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/preview',
      payload: { periodType: 'weekly', anchor: '2026-07-06', count: 4 },
      headers: { 'content-type': 'application/json' },
    });
    // Median of [4500, 5000, 5500, 6000] = (5000+5500)/2 = 5250.
    expect(r.json().preview.groceriesWeeklyMedianCents).toBe(5250);
    // Weekly period of 7 days × 5250 / 7 = 5250.
    expect(r.json().preview.periods[0].groceriesCents).toBe(5250);
  });

  it('commit creates the editable rows + one bill-linked row per bill instance', async () => {
    const bill = await app.inject({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'Internet',
        amountCents: 8000,
        frequency: 'monthly',
        nextDueDate: '2026-06-15',
      },
      headers: { 'content-type': 'application/json' },
    });
    const billId = bill.json().bill.id;

    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/commit',
      payload: {
        periodType: 'monthly',
        anchor: '2026-06-01',
        count: 2,
        groceriesOverrideCents: { 0: 50000, 1: 55000 },
        fuelOverrideCents: { 0: 20000, 1: 20000 },
        tollsOverrideCents: { 0: 8000, 1: 8000 },
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const result = r.json().result;
    // 2 periods × 3 editable + 2 bill instances = 8 rows.
    expect(result.created).toBe(8);

    const rows = await pool.query(
      `SELECT period_month, category_id, bill_id, amount_cents
         FROM budgets ORDER BY period_month, category_id, bill_id`,
    );
    expect(rows.rowCount).toBe(8);
    const billRows = rows.rows.filter((r) => r.bill_id === billId);
    expect(billRows).toHaveLength(2);
    expect(billRows[0]!.amount_cents).toBe(8000);
  });

  it('commit re-run skips duplicates', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/commit',
      payload: { periodType: 'monthly', anchor: '2026-06-01', count: 1, groceriesOverrideCents: { 0: 50000 }, fuelOverrideCents: { 0: 20000 }, tollsOverrideCents: { 0: 8000 } },
      headers: { 'content-type': 'application/json' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/commit',
      payload: { periodType: 'monthly', anchor: '2026-06-01', count: 1, groceriesOverrideCents: { 0: 50000 }, fuelOverrideCents: { 0: 20000 }, tollsOverrideCents: { 0: 8000 } },
      headers: { 'content-type': 'application/json' },
    });
    expect(second.json().result.created).toBe(0);
    expect(second.json().result.skipped).toBe(3);

    void [groceries, gasFuel, tolls]; // suppress unused
  });

  it('preview computes fuel cost from active vehicles + cached price', async () => {
    // 30 mpg, 250 weekly miles, regular gas at $3.50/gal.
    // 0.17.6 — vehicle must be scoped to the test's default tenant
    // since the wizard preview now joins via tenant_id (the old
    // no-tenant-filter query was a cross-tenant leak).
    await pool.query(
      `INSERT INTO vehicles
         (tenant_id, name, fuel_type, mpg, weekly_avg_miles)
       VALUES ((SELECT id FROM tenants WHERE slug='default'),
               'Civic', 'regular', 30, 250)`,
    );
    await pool.query(
      `INSERT INTO fuel_prices (fuel_type, price_cents_per_gallon, source)
       VALUES ('regular', 350, 'manual')`,
    );
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/preview',
      payload: { periodType: 'weekly', anchor: '2026-06-01', count: 1 },
      headers: { 'content-type': 'application/json' },
    });
    // 250 miles / 30 mpg × $3.50/gal = ~$29.17 = 2917 cents.
    expect(r.json().preview.periods[0].fuelCents).toBe(2917);
  });

  it('preview sums tolls from active commute routes with assignments', async () => {
    // Two active routes, each with a per-crossing toll + a vehicle taking it.
    // 0.17.6 — vehicles + routes must be tenant-scoped now.
    const vehicle = await pool.query<{ id: string }>(
      `INSERT INTO vehicles (tenant_id, name, fuel_type, mpg, weekly_avg_miles)
       VALUES ((SELECT id FROM tenants WHERE slug='default'),
               'Daily', 'regular', 30, 0) RETURNING id`,
    );
    const r1 = await pool.query<{ id: string }>(
      `INSERT INTO commute_routes (tenant_id, name, distance_miles, toll_per_crossing_cents)
       VALUES ((SELECT id FROM tenants WHERE slug='default'),
               'Hwy 99', 20, 450) RETURNING id`,
    );
    const r2 = await pool.query<{ id: string }>(
      `INSERT INTO commute_routes (tenant_id, name, distance_miles, toll_per_crossing_cents)
       VALUES ((SELECT id FROM tenants WHERE slug='default'),
               'Bay Bridge', 10, 250) RETURNING id`,
    );
    await pool.query(
      `INSERT INTO route_vehicle_assignments (route_id, vehicle_id, crossings_per_week)
       VALUES ($1, $2, 10), ($3, $2, 10)`,
      [r1.rows[0]!.id, vehicle.rows[0]!.id, r2.rows[0]!.id],
    );
    // Inactive route with toll should NOT contribute.
    await pool.query(
      `INSERT INTO commute_routes (tenant_id, name, distance_miles, toll_per_crossing_cents, active)
       VALUES ((SELECT id FROM tenants WHERE slug='default'),
               'Old route', 5, 9999, false)`,
    );
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/preview',
      payload: { periodType: 'weekly', anchor: '2026-06-01', count: 1 },
      headers: { 'content-type': 'application/json' },
    });
    // (10 * 450) + (10 * 250) = 7000
    expect(r.json().preview.periods[0].tollsCents).toBe(7000);
  });
});
