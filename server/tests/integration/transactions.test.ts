import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb, seedAccount, pool } from '../setup/test-db.js';

async function seedTransaction(
  accountId: string,
  date: string,
  amountCents: number,
  description: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [accountId, date, amountCents, description, randomUUID()],
  );
}

describe('Transactions API', () => {
  let app: FastifyInstance;
  let accountId: string;
  let otherAccountId: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb();
    accountId = await seedAccount({ name: 'Primary' });
    otherAccountId = await seedAccount({ name: 'Secondary' });
    await seedTransaction(accountId, '2026-05-01', -1000, 'COFFEE SHOP');
    await seedTransaction(accountId, '2026-05-05', -2500, 'GROCERY STORE');
    await seedTransaction(accountId, '2026-05-10', 150000, 'PAYCHECK');
    await seedTransaction(accountId, '2026-05-15', -799, 'COFFEE SHOP AGAIN');
    await seedTransaction(
      otherAccountId,
      '2026-05-20',
      -5000,
      'OTHER ACCOUNT TXN',
    );
  });

  it('lists every transaction', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/transactions' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(5);
  });

  it('filters by account', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/transactions?accountId=${accountId}`,
    });
    expect(res.json().total).toBe(4);
    expect(
      res
        .json()
        .transactions.every((t: { account_id: string }) => t.account_id === accountId),
    ).toBe(true);
  });

  it('searches descriptions case-insensitively', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/transactions?search=coffee',
    });
    expect(res.json().total).toBe(2);
  });

  it('paginates with limit and offset', async () => {
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/transactions?limit=2&offset=0',
    });
    expect(page1.json().transactions).toHaveLength(2);
    expect(page1.json().total).toBe(5);

    const lastPage = await app.inject({
      method: 'GET',
      url: '/api/transactions?limit=2&offset=4',
    });
    expect(lastPage.json().transactions).toHaveLength(1);
  });

  it('orders by transaction date, newest first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/transactions?accountId=${accountId}`,
    });
    const dates: string[] = res
      .json()
      .transactions.map((t: { txn_date: string }) => t.txn_date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('rejects a malformed accountId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/transactions?accountId=not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
  });
});
