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
    `SELECT id FROM categories WHERE lower(name) = lower($1) LIMIT 1`,
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
}): Promise<void> {
  await pool.query(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash,
        category_id, transfer_group_id)
     VALUES ($1, $2, $3, 'T', $4, $5, $6)`,
    [
      opts.accountId,
      opts.date,
      opts.amountCents,
      randomUUID(),
      opts.categoryId ?? null,
      opts.transferGroupId ?? null,
    ],
  );
}

describe('Budgets API', () => {
  let app: FastifyInstance;
  let accountId: string;
  let groceries: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    accountId = await seedAccount();
    groceries = await categoryId('Groceries');
  });

  it('creates a budget then lists it', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        periodMonth: '2026-05-01',
        categoryId: groceries,
        amountCents: 50000,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().budget.amount_cents).toBe(50000);

    const list = await app.inject({
      method: 'GET',
      url: '/api/budgets?month=2026-05-01',
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().budgets).toHaveLength(1);
  });

  it('upserts the same (month, category) — second POST updates', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        periodMonth: '2026-05-01',
        categoryId: groceries,
        amountCents: 50000,
      },
      headers: { 'content-type': 'application/json' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        periodMonth: '2026-05-01',
        categoryId: groceries,
        amountCents: 60000,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().budget.amount_cents).toBe(60000);

    const list = await app.inject({
      method: 'GET',
      url: '/api/budgets?month=2026-05-01',
    });
    expect(list.json().budgets).toHaveLength(1);
  });

  it('rejects a non-first-of-month period', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        periodMonth: '2026-05-15',
        categoryId: groceries,
        amountCents: 10000,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('treats categoryId: null as the flex pool — unique per month', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        periodMonth: '2026-05-01',
        categoryId: null,
        amountCents: 30000,
      },
      headers: { 'content-type': 'application/json' },
    });
    const update = await app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        periodMonth: '2026-05-01',
        categoryId: null,
        amountCents: 40000,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(update.json().budget.amount_cents).toBe(40000);
    const list = await app.inject({
      method: 'GET',
      url: '/api/budgets?month=2026-05-01',
    });
    expect(list.json().budgets).toHaveLength(1);
  });

  it('copy endpoint clones budgets from one month to another', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        periodMonth: '2026-04-01',
        categoryId: groceries,
        amountCents: 50000,
      },
      headers: { 'content-type': 'application/json' },
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/copy',
      payload: { fromMonth: '2026-04-01', toMonth: '2026-05-01' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.json().copied).toBe(1);
    const list = await app.inject({
      method: 'GET',
      url: '/api/budgets?month=2026-05-01',
    });
    expect(list.json().budgets[0]!.amount_cents).toBe(50000);
  });

  describe('budget-vs-actual', () => {
    it('reports actual spending for a category budget and excludes transfers', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/budgets',
        payload: {
          periodMonth: '2026-05-01',
          categoryId: groceries,
          amountCents: 50000,
        },
        headers: { 'content-type': 'application/json' },
      });
      await seedTxn({ accountId, date: '2026-05-05', amountCents: -2500, categoryId: groceries });
      await seedTxn({ accountId, date: '2026-05-15', amountCents: -1500, categoryId: groceries });
      // Transfer — must be excluded.
      const otherAcct = await seedAccount({ name: 'Savings', type: 'savings' });
      const transferGroup = randomUUID();
      await seedTxn({ accountId, date: '2026-05-10', amountCents: -10000, categoryId: groceries, transferGroupId: transferGroup });
      await seedTxn({ accountId: otherAcct, date: '2026-05-10', amountCents: 10000, transferGroupId: transferGroup });

      const r = await app.inject({
        method: 'GET',
        url: '/api/budgets/actual?month=2026-05-01',
      });
      expect(r.statusCode).toBe(200);
      const row = r.json().rows[0]!;
      expect(row.budgeted_cents).toBe(50000);
      expect(row.actual_cents).toBe(4000);
    });

    it('flex pool catches spending in non-budgeted categories only', async () => {
      const fun = await categoryId('Restaurants');
      // Budget: only groceries.
      await app.inject({
        method: 'POST',
        url: '/api/budgets',
        payload: {
          periodMonth: '2026-05-01',
          categoryId: groceries,
          amountCents: 50000,
        },
        headers: { 'content-type': 'application/json' },
      });
      // Flex pool.
      await app.inject({
        method: 'POST',
        url: '/api/budgets',
        payload: {
          periodMonth: '2026-05-01',
          categoryId: null,
          amountCents: 30000,
        },
        headers: { 'content-type': 'application/json' },
      });
      await seedTxn({ accountId, date: '2026-05-05', amountCents: -2500, categoryId: groceries });
      await seedTxn({ accountId, date: '2026-05-08', amountCents: -1800, categoryId: fun });
      await seedTxn({ accountId, date: '2026-05-09', amountCents: -700 }); // uncategorized

      const r = await app.inject({
        method: 'GET',
        url: '/api/budgets/actual?month=2026-05-01',
      });
      const rows = r.json().rows;
      const groceriesRow = rows.find((x: { category_id: string | null }) => x.category_id === groceries);
      const flexRow = rows.find((x: { category_id: string | null }) => x.category_id === null);
      expect(groceriesRow.actual_cents).toBe(2500);
      // Flex = $18 (dining) + $7 (uncategorized) = $25.
      expect(flexRow.actual_cents).toBe(2500);
    });
  });

  it('DELETE removes the budget', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        periodMonth: '2026-05-01',
        categoryId: groceries,
        amountCents: 50000,
      },
      headers: { 'content-type': 'application/json' },
    });
    const id = create.json().budget.id;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/budgets/${id}`,
    });
    expect(del.statusCode).toBe(204);
  });
});
