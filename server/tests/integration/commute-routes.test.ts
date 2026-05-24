import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeSuperAdminCookie, makeTestApp, pool, resetDb } from '../setup/test-db.js';

async function defaultTenantId(): Promise<string> {
  const t = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
  );
  return t.rows[0]!.id;
}

async function seedVehicle(name: string): Promise<string> {
  // 0.14.4: vehicles + commute_routes + route_vehicle_assignments
  // are tenant-scoped. Direct INSERTs need the Default tenant id so
  // the routes can find them.
  const tenantId = await defaultTenantId();
  const r = await pool.query<{ id: string }>(
    `INSERT INTO vehicles (tenant_id, name, fuel_type, mpg, weekly_avg_miles)
     VALUES ($1, $2, 'regular', 30, 0) RETURNING id`,
    [tenantId, name],
  );
  return r.rows[0]!.id;
}

describe('Commute routes API', () => {
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

  it('creates a route with assignments in one call', async () => {
    const v = await seedVehicle('Civic');
    const r = await app.inject({
      method: 'POST',
      url: '/api/commute-routes',
      payload: {
        name: 'School run',
        distanceMiles: 5.2,
        tollPerCrossingCents: 0,
        assignments: [{ vehicleId: v, crossingsPerWeek: 10 }],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().route.distance_miles).toBeCloseTo(5.2);
    const list = await app.inject({ method: 'GET', url: '/api/commute-routes' });
    expect(list.json().routes[0].assignments).toHaveLength(1);
    expect(list.json().routes[0].assignments[0].crossings_per_week).toBe(10);
  });

  it('allows a toll-only route (distance=0, has toll, no assignments)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/commute-routes',
      payload: {
        name: 'Standalone bridge toll',
        distanceMiles: 0,
        tollPerCrossingCents: 700,
        assignments: [],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
    // Toll only contributes when at least one vehicle crosses it.
  });

  it('rejects negative distance or crossings', async () => {
    const v = await seedVehicle('Civic');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/commute-routes',
      payload: {
        name: 'Bad',
        distanceMiles: -1,
        assignments: [{ vehicleId: v, crossingsPerWeek: 5 }],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('PUT /assignments replaces the entire set', async () => {
    const v1 = await seedVehicle('A');
    const v2 = await seedVehicle('B');
    const create = await app.inject({
      method: 'POST',
      url: '/api/commute-routes',
      payload: {
        name: 'R',
        distanceMiles: 10,
        assignments: [{ vehicleId: v1, crossingsPerWeek: 5 }],
      },
      headers: { 'content-type': 'application/json' },
    });
    const id = create.json().route.id;
    await app.inject({
      method: 'PUT',
      url: `/api/commute-routes/${id}/assignments`,
      payload: {
        assignments: [{ vehicleId: v2, crossingsPerWeek: 7 }],
      },
      headers: { 'content-type': 'application/json' },
    });
    const list = await app.inject({ method: 'GET', url: '/api/commute-routes' });
    const route = list.json().routes.find((r: { id: string }) => r.id === id);
    expect(route.assignments).toHaveLength(1);
    expect(route.assignments[0].vehicle_id).toBe(v2);
  });

  it('deleting a route cascades its assignments', async () => {
    const v = await seedVehicle('Civic');
    const create = await app.inject({
      method: 'POST',
      url: '/api/commute-routes',
      payload: {
        name: 'R',
        distanceMiles: 10,
        assignments: [{ vehicleId: v, crossingsPerWeek: 5 }],
      },
      headers: { 'content-type': 'application/json' },
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/commute-routes/${create.json().route.id}`,
    });
    const r = await pool.query(`SELECT COUNT(*) AS c FROM route_vehicle_assignments`);
    expect(Number(r.rows[0]!.c)).toBe(0);
  });
});

describe('Budget wizard with route-driven fuel + misc + savings', () => {
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

  it('route-assigned vehicle uses derived miles, not weekly_avg_miles', async () => {
    // Vehicle has weekly_avg_miles=999 but assignment says 100 miles/week.
    // Derived must win.
    const tenantId = await defaultTenantId();
    const v = await pool.query<{ id: string }>(
      `INSERT INTO vehicles (tenant_id, name, fuel_type, mpg, weekly_avg_miles)
       VALUES ($1, 'Civic', 'regular', 30, 999) RETURNING id`,
      [tenantId],
    );
    await pool.query(`INSERT INTO fuel_prices (fuel_type, price_cents_per_gallon, source) VALUES ('regular', 300, 'manual')`);
    const route = await pool.query<{ id: string }>(
      `INSERT INTO commute_routes (tenant_id, name, distance_miles)
       VALUES ($1, 'Commute', 50) RETURNING id`,
      [tenantId],
    );
    // 2 crossings/wk × 50 mi = 100 mi/wk.
    await pool.query(
      `INSERT INTO route_vehicle_assignments (tenant_id, route_id, vehicle_id, crossings_per_week)
       VALUES ($1, $2, $3, 2)`,
      [tenantId, route.rows[0]!.id, v.rows[0]!.id],
    );
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/preview',
      payload: { periodType: 'weekly', anchor: '2026-06-01', count: 1 },
      headers: { 'content-type': 'application/json' },
    });
    // 100 mi / 30 mpg × $3.00 = $10.00 = 1000 cents (not the 999 mi × ... value).
    expect(r.json().preview.periods[0].fuelCents).toBe(1000);
  });

  it('vehicle without assignments falls back to weekly_avg_miles', async () => {
    // No routes, no assignments — weekly_avg_miles is the only signal.
    const tenantId = await defaultTenantId();
    await pool.query(
      `INSERT INTO vehicles (tenant_id, name, fuel_type, mpg, weekly_avg_miles)
       VALUES ($1, 'Civic', 'regular', 30, 90)`,
      [tenantId],
    );
    await pool.query(`INSERT INTO fuel_prices (fuel_type, price_cents_per_gallon, source) VALUES ('regular', 300, 'manual')`);
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/preview',
      payload: { periodType: 'weekly', anchor: '2026-06-01', count: 1 },
      headers: { 'content-type': 'application/json' },
    });
    // 90 / 30 × $3 = $9 = 900 cents.
    expect(r.json().preview.periods[0].fuelCents).toBe(900);
  });

  it('preview emits misc default 0 and savings suggestions', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/preview',
      payload: { periodType: 'weekly', anchor: '2026-06-01', count: 1 },
      headers: { 'content-type': 'application/json' },
    });
    const p = r.json().preview.periods[0];
    expect(p.miscCents).toBe(0);
    expect(p.miscNote).toBe('');
    expect(p.savingsCents).toBe(0);
    expect(p.savingsSuggestions).toMatchObject({
      goalRequiredCents: 0,
      pctIncomeCents: 0,
      pctLeftoverCents: 0,
      maxCents: 0,
    });
  });

  it('goal-driven savings suggestion uses (target - current) / periods_to_target', async () => {
    // $1000 goal, $0 current, target ~10 weeks away. Per-week required ≈ $100.
    const target = new Date();
    target.setUTCDate(target.getUTCDate() + 70);
    // 0.17.6 — savings_goals must be tenant-scoped; the wizard
    // preview now filters by tenant.
    await pool.query(
      `INSERT INTO savings_goals (tenant_id, name, target_amount_cents, current_amount_cents, target_date)
       VALUES ((SELECT id FROM tenants WHERE slug='default'),
               'Vacation', 100000, 0, $1::date)`,
      [target.toISOString().slice(0, 10)],
    );
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/preview',
      payload: { periodType: 'weekly', anchor: new Date().toISOString().slice(0, 10), count: 1 },
      headers: { 'content-type': 'application/json' },
    });
    const s = r.json().preview.periods[0].savingsSuggestions;
    // target is 70d out; first period.end is anchor + 7d, so periods_to_target
    // ≈ 63/7 = 9. required ≈ 100000/9 ≈ 11111. Wide range for boundary slack.
    expect(s.goalRequiredCents).toBeGreaterThanOrEqual(9500);
    expect(s.goalRequiredCents).toBeLessThanOrEqual(12500);
  });

  it('commit writes misc + savings rows when amounts > 0', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/commit',
      payload: {
        name: 'Test plan',
        periodType: 'weekly',
        anchor: '2026-06-01',
        count: 1,
        miscOverrideCents: { 0: 5000 },
        miscNoteOverride: { 0: "Mom's birthday" },
        savingsOverrideCents: { 0: 10000 },
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const rows = await pool.query(
      `SELECT b.amount_cents, b.note, c.name AS category_name
         FROM budgets b
    LEFT JOIN categories c ON c.id = b.category_id
        WHERE b.period_month = '2026-06-01'
     ORDER BY c.name`,
    );
    const misc = rows.rows.find((row: { category_name: string }) => row.category_name === 'Miscellaneous');
    const savings = rows.rows.find((row: { category_name: string }) => row.category_name === 'Savings');
    expect(misc.amount_cents).toBe(5000);
    expect(misc.note).toBe("Mom's birthday");
    expect(savings.amount_cents).toBe(10000);
  });
});

describe('AI models endpoint (super-admin only as of 0.9.3)', () => {
  let app: FastifyInstance;
  let superCookie: string;
  beforeAll(async () => { app = await makeTestApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await resetDb();
    superCookie = await makeSuperAdminCookie(app);
  });

  it('claude returns the hardcoded list with one recommended entry', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/settings/ai-models?provider=claude',
      headers: { cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(200);
    const ids = r.json().models.map((m: { id: string }) => m.id);
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-opus-4-7');
    const recommended = r.json().models.filter((m: { recommended: boolean }) => m.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].id).toBe('claude-haiku-4-5');
  });

  it('ollama falls back when the configured base URL is unreachable', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/settings/ai-models?provider=ollama',
      headers: { cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(200);
    expect(r.json().models.length).toBeGreaterThan(0);
  });

  it('unknown provider returns an empty list', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/settings/ai-models?provider=none',
      headers: { cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.json().models).toEqual([]);
  });
});
