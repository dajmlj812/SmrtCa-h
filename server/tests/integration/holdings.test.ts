import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, pool, resetDb, seedAccount } from '../setup/test-db.js';

describe('Holdings + manual A&L + net worth', () => {
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

  describe('holdings CRUD', () => {
    it('creates a holding on an investment account', async () => {
      const inv = await seedAccount({ name: 'Brokerage', type: 'investment' });
      const r = await app.inject({
        method: 'POST',
        url: '/api/holdings',
        payload: {
          accountId: inv,
          symbol: 'voo',
          name: 'Vanguard S&P 500',
          quantity: 10.5,
          costBasisCents: 400000,
          lastPriceCents: 50000,
          lastPriceDate: '2026-05-20',
        },
        headers: { 'content-type': 'application/json' },
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().holding.symbol).toBe('VOO'); // uppercased
      expect(r.json().holding.quantity).toBeCloseTo(10.5);
    });

    it('rejects holdings on non-investment accounts', async () => {
      const checking = await seedAccount({ name: 'Checking', type: 'checking' });
      const r = await app.inject({
        method: 'POST',
        url: '/api/holdings',
        payload: {
          accountId: checking,
          name: 'X',
          quantity: 1,
        },
        headers: { 'content-type': 'application/json' },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/investment/i);
    });

    it('mark-to-market updates the last price', async () => {
      const inv = await seedAccount({ name: 'Brokerage', type: 'investment' });
      const create = await app.inject({
        method: 'POST',
        url: '/api/holdings',
        payload: {
          accountId: inv,
          name: 'VOO',
          quantity: 10,
          lastPriceCents: 50000,
        },
        headers: { 'content-type': 'application/json' },
      });
      const id = create.json().holding.id;
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/holdings/${id}`,
        payload: { lastPriceCents: 52000, lastPriceDate: '2026-05-23' },
        headers: { 'content-type': 'application/json' },
      });
      expect(patch.json().holding.last_price_cents).toBe(52000);
    });

    it('rejects negative quantity', async () => {
      const inv = await seedAccount({ name: 'Brokerage', type: 'investment' });
      const r = await app.inject({
        method: 'POST',
        url: '/api/holdings',
        payload: { accountId: inv, name: 'X', quantity: -1 },
        headers: { 'content-type': 'application/json' },
      });
      expect(r.statusCode).toBe(400);
    });
  });

  describe('account balance includes holdings + manual types', () => {
    it("investment account's balance equals cash + market value of holdings", async () => {
      const inv = await seedAccount({ name: 'Brokerage', type: 'investment' });
      // Cash side: $500 opening balance.
      await app.inject({
        method: 'PATCH',
        url: `/api/accounts/${inv}`,
        payload: { opening_balance_cents: 50000 },
        headers: { 'content-type': 'application/json' },
      });
      // 10 shares @ $50 = $500 market value.
      await app.inject({
        method: 'POST',
        url: '/api/holdings',
        payload: { accountId: inv, name: 'VOO', quantity: 10, lastPriceCents: 5000 },
        headers: { 'content-type': 'application/json' },
      });
      const r = await app.inject({ method: 'GET', url: `/api/accounts/${inv}` });
      expect(r.json().account.holdings_value_cents).toBe(50000);
      expect(r.json().account.balance_cents).toBe(100000); // 500 cash + 500 market
    });

    it('manual_asset and manual_liability can be created', async () => {
      const asset = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'House', type: 'manual_asset' },
        headers: { 'content-type': 'application/json' },
      });
      expect(asset.statusCode).toBe(201);

      const liab = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Mortgage', type: 'manual_liability' },
        headers: { 'content-type': 'application/json' },
      });
      expect(liab.statusCode).toBe(201);
    });
  });

  describe('net worth over time includes investments + manual A&L', () => {
    it('reflects holdings market value and manual liabilities', async () => {
      // Cash: +$10k checking.
      const checking = await seedAccount({ name: 'Checking', type: 'checking' });
      await pool.query(
        `UPDATE accounts SET opening_balance_cents = 1000000 WHERE id = $1`,
        [checking],
      );

      // Investments: 10 shares @ $500 = $5k.
      const inv = await seedAccount({ name: 'Brokerage', type: 'investment' });
      await pool.query(
        `INSERT INTO holdings (account_id, name, quantity, last_price_cents)
         VALUES ($1, 'VOO', 10, 50000)`,
        [inv],
      );

      // Asset: house = $500k.
      const house = await seedAccount({ name: 'House', type: 'manual_asset' });
      await pool.query(
        `UPDATE accounts SET opening_balance_cents = 50000000 WHERE id = $1`,
        [house],
      );

      // Liability: mortgage = -$400k (stored negative).
      const mortgage = await seedAccount({ name: 'Mortgage', type: 'manual_liability' });
      await pool.query(
        `UPDATE accounts SET opening_balance_cents = -40000000 WHERE id = $1`,
        [mortgage],
      );

      const r = await app.inject({
        method: 'GET',
        url: '/api/insights/net-worth-over-time?months=3',
      });
      const rows = r.json().rows;
      // Latest month: 1_000_000 + 500_000 + 50_000_000 - 40_000_000 = 11_500_000 cents.
      expect(rows[rows.length - 1]!.net_worth_cents).toBe(11500000);
    });
  });
});
