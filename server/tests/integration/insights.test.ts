import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  pool,
  resetDb,
  seedAccount,
} from '../setup/test-db.js';

async function categoryId(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    'SELECT id FROM categories WHERE lower(name) = lower($1) LIMIT 1',
    [name],
  );
  return r.rows[0]!.id;
}

async function seedTxn(opts: {
  accountId: string;
  date: string;
  amountCents: number;
  categoryId?: string | null;
  transferGroupId?: string | null;
}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash,
        category_id, transfer_group_id)
     VALUES ($1, $2, $3, 'Test', $4, $5, $6)
     RETURNING id`,
    [
      opts.accountId,
      opts.date,
      opts.amountCents,
      randomUUID(),
      opts.categoryId ?? null,
      opts.transferGroupId ?? null,
    ],
  );
  return r.rows[0]!.id;
}

describe('Insights API', () => {
  let app: FastifyInstance;
  let accountId: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    accountId = await seedAccount();
  });

  describe('spending-by-category', () => {
    it('aggregates negative amounts per category and excludes transfers', async () => {
      const groceries = await categoryId('Groceries');
      const transferGroup = randomUUID();

      await seedTxn({ accountId, date: '2026-05-05', amountCents: -2500, categoryId: groceries });
      await seedTxn({ accountId, date: '2026-05-12', amountCents: -1500, categoryId: groceries });
      // Transfer (excluded).
      const otherAccount = await seedAccount({ name: 'Savings', type: 'savings' });
      await seedTxn({ accountId, date: '2026-05-10', amountCents: -10000, transferGroupId: transferGroup });
      await seedTxn({ accountId: otherAccount, date: '2026-05-10', amountCents: 10000, transferGroupId: transferGroup });
      // Income (excluded — positive amount).
      await seedTxn({ accountId, date: '2026-05-15', amountCents: 5000 });

      const res = await app.inject({
        method: 'GET',
        url: '/api/insights/spending-by-category?start=2026-05-01&end=2026-05-31',
      });
      expect(res.statusCode).toBe(200);
      const { rows } = res.json();
      const grocRow = rows.find((r: { category_name: string }) => r.category_name === 'Groceries');
      expect(grocRow.total_cents).toBe(4000);
      expect(grocRow.transaction_count).toBe(2);
      // Transfer doesn't appear.
      const totalSpend = rows.reduce(
        (sum: number, r: { total_cents: number }) => sum + r.total_cents,
        0,
      );
      expect(totalSpend).toBe(4000);
    });

    it('honors the date range', async () => {
      const groceries = await categoryId('Groceries');
      await seedTxn({ accountId, date: '2026-04-15', amountCents: -1000, categoryId: groceries });
      await seedTxn({ accountId, date: '2026-05-05', amountCents: -2500, categoryId: groceries });

      const res = await app.inject({
        method: 'GET',
        url: '/api/insights/spending-by-category?start=2026-05-01&end=2026-05-31',
      });
      expect(res.json().rows[0].total_cents).toBe(2500);
    });
  });

  describe('income-expense', () => {
    it('buckets by month, excluding transfers', async () => {
      const transferGroup = randomUUID();
      const today = new Date();
      const thisMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-15`;

      await seedTxn({ accountId, date: thisMonth, amountCents: 50000 });   // income 500
      await seedTxn({ accountId, date: thisMonth, amountCents: -20000 });  // expense 200
      // Transfer pair (excluded).
      const other = await seedAccount({ name: 'Savings', type: 'savings' });
      await seedTxn({ accountId, date: thisMonth, amountCents: -10000, transferGroupId: transferGroup });
      await seedTxn({ accountId: other, date: thisMonth, amountCents: 10000, transferGroupId: transferGroup });

      const res = await app.inject({
        method: 'GET',
        url: '/api/insights/income-expense?months=3',
      });
      expect(res.statusCode).toBe(200);
      const { rows } = res.json();
      expect(rows.length).toBe(3);
      const thisRow = rows[rows.length - 1]!;
      expect(thisRow.income_cents).toBe(50000);
      expect(thisRow.expense_cents).toBe(20000);
    });

    it('clamps months to [1, 60]', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/insights/income-expense?months=999',
      });
      expect(res.json().rows.length).toBe(60);
    });
  });

  describe('net-worth-over-time', () => {
    it('sums opening balances + cumulative txns per month-end', async () => {
      // One account with $1,000 opening as of beginning of this year,
      // plus a $200 outflow last month.
      await app.inject({
        method: 'PATCH',
        url: `/api/accounts/${accountId}`,
        payload: {
          opening_balance_cents: 100000,
          opening_balance_date: '2026-01-01',
        },
        headers: { 'content-type': 'application/json' },
      });
      const today = new Date();
      const lastMonth = new Date(today.getUTCFullYear(), today.getUTCMonth() - 1, 15);
      const lastMonthYmd = lastMonth.toISOString().slice(0, 10);
      await seedTxn({ accountId, date: lastMonthYmd, amountCents: -20000 });

      const res = await app.inject({
        method: 'GET',
        url: '/api/insights/net-worth-over-time?months=3',
      });
      const { rows } = res.json();
      expect(rows.length).toBe(3);
      // Latest month: opening + (-200) = 800.
      expect(rows[rows.length - 1]!.net_worth_cents).toBe(80000);
    });
  });

  it('rejects malformed start date', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/insights/spending-by-category?start=not-a-date',
    });
    expect(res.statusCode).toBe(400);
  });
});
