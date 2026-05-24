import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeSuperAdminCookie, makeTestApp, pool, resetDb } from '../setup/test-db.js';

/**
 * Phase 7.1 multi-currency (0.10.0) — coverage for the persistence
 * layer + the accounts endpoint's display-currency projection.
 *
 * The provider-side refresh (open.er-api.com) isn't exercised here —
 * tests don't reach the public internet. The success path is covered
 * by manual rate writes through the same DB code that the fetcher
 * uses.
 */

describe('Exchange rates + display-currency projection (0.10.0)', () => {
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

  it('tenant user can GET rates; super-only mutates', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/exchange-rates' });
    expect(list.statusCode).toBe(200);
    expect(list.json().rates).toEqual([]);
    expect(list.json().display_currency).toBe('USD');

    const blockedPost = await app.inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.9 },
      headers: { 'content-type': 'application/json' },
    });
    expect(blockedPost.statusCode).toBe(403);
  });

  it('super admin can set a manual rate and see it in the list', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.92 },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(created.statusCode).toBe(201);
    expect(created.json().rate.source).toBe('manual');
    expect(Number(created.json().rate.rate)).toBeCloseTo(0.92, 4);

    const list = await app.inject({ method: 'GET', url: '/api/exchange-rates' });
    expect(list.json().rates).toHaveLength(1);
    expect(list.json().rates[0].from_currency).toBe('USD');
  });

  it('rejects a non-positive rate', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { fromCurrency: 'USD', toCurrency: 'EUR', rate: -1 },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(400);
  });

  it('rejects identical from + to', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { fromCurrency: 'USD', toCurrency: 'USD', rate: 1 },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(400);
  });

  it('accounts list projects balances into the display currency', async () => {
    // Seed two accounts: one USD, one EUR. USD opening 100000 cents
    // ($1000), EUR opening 50000 cents (€500). No transactions.
    // 0.14.0: tenant-scoped GET /api/accounts requires tenant_id.
    const t = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
    );
    const tenantId = t.rows[0]!.id;
    await pool.query(
      `INSERT INTO accounts (tenant_id, name, institution, type, last4, currency, opening_balance_cents)
       VALUES
         ($1, 'US Checking', 'Bank', 'checking', '0000', 'USD', 100000),
         ($1, 'EU Checking', 'Bank', 'checking', '0000', 'EUR', 50000)`,
      [tenantId],
    );
    // Display currency is USD; set a USD→EUR rate of 0.5 — so EUR
    // 500 should project to USD 1000 (€500 / 0.5 = $1000) via the
    // 1/rate inverse path.
    await pool.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, source)
       VALUES ('USD', 'EUR', 0.5, 'manual')`,
    );
    const r = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.display_currency).toBe('USD');
    const us = body.accounts.find((a: { name: string }) => a.name === 'US Checking');
    const eu = body.accounts.find((a: { name: string }) => a.name === 'EU Checking');
    expect(us.balance_display_cents).toBe(100000);
    expect(us.rate_known).toBe(true);
    expect(eu.balance_display_cents).toBe(100000); // 50000 / 0.5
    expect(eu.rate_known).toBe(true);
  });

  it('rate_known=false when there is no FX pair for an account currency', async () => {
    const t = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
    );
    await pool.query(
      `INSERT INTO accounts (tenant_id, name, institution, type, last4, currency, opening_balance_cents)
       VALUES ($1, 'JP Checking', 'Bank', 'checking', '0000', 'JPY', 100000)`,
      [t.rows[0]!.id],
    );
    const r = await app.inject({ method: 'GET', url: '/api/accounts' });
    const row = r.json().accounts[0];
    expect(row.currency).toBe('JPY');
    expect(row.rate_known).toBe(false);
    // Pass-through value when no rate is known.
    expect(row.balance_display_cents).toBe(100000);
  });

  it('DELETE drops every rate for a pair', async () => {
    await pool.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, source)
       VALUES ('USD', 'GBP', 0.78, 'manual'),
              ('USD', 'GBP', 0.79, 'manual')`,
    );
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/exchange-rates/USD/GBP',
      headers: { cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(200);
    expect(r.json().removed).toBe(2);
  });
});
