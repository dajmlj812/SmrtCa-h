import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb } from '../setup/test-db.js';
import { computeProjection } from '../../src/domain/projections.js';

/**
 * Phase 7.2 retirement projections (0.10.1).
 *
 * Math tests run against the pure helper; CRUD tests round-trip
 * through the API.
 */

describe('computeProjection math (0.10.1)', () => {
  it('zero contribution + 0% return holds the balance flat', () => {
    const series = computeProjection({
      startingBalanceCents: 100000,
      monthlyContributionCents: 0,
      annualReturnPct: 0,
      annualInflationPct: 0,
      horizonYears: 5,
      baseYear: 2026,
    });
    expect(series).toHaveLength(6);
    expect(series[0]!.nominal_cents).toBe(100000);
    expect(series[5]!.nominal_cents).toBe(100000);
  });

  it('compound growth: $0 start, $100/mo, 10% return, 10y ~= $20K', () => {
    // FV of an annuity due ~ 20484; the helper uses end-of-month
    // contributions then end-of-month growth so result is slightly
    // different but in the same ballpark. Sanity bounds:
    const series = computeProjection({
      startingBalanceCents: 0,
      monthlyContributionCents: 10000, // $100
      annualReturnPct: 10,
      annualInflationPct: 0,
      horizonYears: 10,
      baseYear: 2026,
    });
    const end = series.at(-1)!.nominal_cents;
    // ~$20K in cents — well above $15K (linear floor at $12K), well
    // under $25K (compound ceiling for 10y@10%).
    expect(end).toBeGreaterThan(1500000);
    expect(end).toBeLessThan(2500000);
  });

  it('inflation deflates real_cents but not nominal_cents', () => {
    const series = computeProjection({
      startingBalanceCents: 100000,
      monthlyContributionCents: 0,
      annualReturnPct: 5,
      annualInflationPct: 3,
      horizonYears: 10,
      baseYear: 2026,
    });
    const end = series.at(-1)!;
    expect(end.nominal_cents).toBeGreaterThan(100000);
    expect(end.real_cents).toBeLessThan(end.nominal_cents);
    // 5% nominal - 3% inflation ~= 2% real; over 10y real ~ +22%
    expect(end.real_cents).toBeGreaterThan(110000);
    expect(end.real_cents).toBeLessThan(140000);
  });

  it('negative return compounds losses', () => {
    const series = computeProjection({
      startingBalanceCents: 100000,
      monthlyContributionCents: 0,
      annualReturnPct: -10,
      annualInflationPct: 0,
      horizonYears: 5,
      baseYear: 2026,
    });
    const end = series.at(-1)!;
    expect(end.nominal_cents).toBeLessThan(100000);
    // -10% over 5y -> roughly 59k
    expect(end.nominal_cents).toBeGreaterThan(50000);
    expect(end.nominal_cents).toBeLessThan(70000);
  });
});

describe('Retirement projection CRUD (0.10.1)', () => {
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

  it('full CRUD + series endpoint', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projections',
      payload: {
        name: 'Retirement',
        startingBalanceCents: 5000000,
        monthlyContributionCents: 150000,
        annualReturnPct: 7,
        annualInflationPct: 2.5,
        horizonYears: 25,
        targetAmountCents: 200000000,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().projection.id as string;
    expect(created.json().projection.name).toBe('Retirement');

    const list = await app.inject({ method: 'GET', url: '/api/projections' });
    expect(list.json().projections).toHaveLength(1);

    const series = await app.inject({
      method: 'GET',
      url: `/api/projections/${id}/series`,
    });
    expect(series.statusCode).toBe(200);
    const body = series.json();
    expect(body.target_amount_cents).toBe(200000000);
    expect(body.series).toHaveLength(26); // year 0 + 25 horizon years
    expect(body.series[0].nominal_cents).toBe(5000000);
    // Ending nominal is larger than starting.
    expect(body.series.at(-1).nominal_cents).toBeGreaterThan(5000000);
    // With inflation, real <= nominal at every step beyond year 0.
    for (let i = 1; i < body.series.length; i++) {
      expect(body.series[i].real_cents).toBeLessThanOrEqual(body.series[i].nominal_cents);
    }
  });

  it('rejects negative monthly contribution', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/projections',
      payload: {
        name: 'Bad',
        startingBalanceCents: 1000,
        monthlyContributionCents: -100,
        annualReturnPct: 5,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects out-of-range return %', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/projections',
      payload: {
        name: 'Bad',
        startingBalanceCents: 1000,
        monthlyContributionCents: 0,
        annualReturnPct: 200,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('PATCH updates and DELETE removes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projections',
      payload: {
        name: 'A',
        startingBalanceCents: 1000,
        monthlyContributionCents: 0,
        annualReturnPct: 5,
      },
      headers: { 'content-type': 'application/json' },
    });
    const id = created.json().projection.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/projections/${id}`,
      payload: { name: 'A renamed', annualReturnPct: 6 },
      headers: { 'content-type': 'application/json' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().projection.name).toBe('A renamed');
    expect(Number(patched.json().projection.annual_return_pct)).toBe(6);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/projections/${id}`,
    });
    expect(deleted.statusCode).toBe(204);
  });
});
