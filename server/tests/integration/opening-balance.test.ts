import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  pool,
  resetDb,
  seedAccount,
} from '../setup/test-db.js';

async function seedTxn(
  accountId: string,
  txnDate: string,
  amountCents: number,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash)
     VALUES ($1, $2, $3, 'Test', $4)
     RETURNING id`,
    [accountId, txnDate, amountCents, randomUUID()],
  );
  return result.rows[0]!.id;
}

describe('Opening balance & running balance', () => {
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

  it('defaults opening_balance_cents to 0 on a new account', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/accounts/${accountId}` });
    const { account } = res.json();
    expect(account.opening_balance_cents).toBe(0);
    expect(account.opening_balance_date).toBeNull();
  });

  it('PATCH sets opening balance and date', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${accountId}`,
      payload: {
        opening_balance_cents: 500000,
        opening_balance_date: '2026-01-01',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.opening_balance_cents).toBe(500000);
    expect(res.json().account.opening_balance_date).toBe('2026-01-01');
  });

  it('rejects invalid opening_balance_date', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${accountId}`,
      payload: { opening_balance_date: 'yesterday' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('balance = opening + sum(txns on/after opening date)', async () => {
    // Set opening = $1,000 as of 2026-03-01.
    await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${accountId}`,
      payload: {
        opening_balance_cents: 100000,
        opening_balance_date: '2026-03-01',
      },
      headers: { 'content-type': 'application/json' },
    });

    // Pre-opening txn — should NOT count.
    await seedTxn(accountId, '2026-02-15', -50000);
    // Post-opening txns.
    await seedTxn(accountId, '2026-03-05', -2000);
    await seedTxn(accountId, '2026-04-10', 5000);

    const res = await app.inject({ method: 'GET', url: `/api/accounts/${accountId}` });
    // 100_000 (opening) + (-2_000) + 5_000 = 103_000
    expect(res.json().account.balance_cents).toBe(103000);
  });

  it('with no opening_balance_date set, balance = opening + sum(ALL txns)', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${accountId}`,
      payload: { opening_balance_cents: 200000 },
      headers: { 'content-type': 'application/json' },
    });
    await seedTxn(accountId, '2025-01-01', -10000);
    await seedTxn(accountId, '2026-05-01', 5000);

    const res = await app.inject({ method: 'GET', url: `/api/accounts/${accountId}` });
    // 200_000 + (-10_000) + 5_000 = 195_000
    expect(res.json().account.balance_cents).toBe(195000);
  });

  it('running_balance_cents reflects opening + cumulative activity', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${accountId}`,
      payload: {
        opening_balance_cents: 100000,
        opening_balance_date: '2026-03-01',
      },
      headers: { 'content-type': 'application/json' },
    });
    await seedTxn(accountId, '2026-03-05', -2000);
    await seedTxn(accountId, '2026-04-10', 5000);

    const res = await app.inject({
      method: 'GET',
      url: `/api/transactions?accountId=${accountId}`,
    });
    const txns = res.json().transactions as Array<{
      txn_date: string;
      running_balance_cents: number | null;
    }>;
    // Newest-first ordering — second txn is first in result.
    const byDate = [...txns].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
    expect(byDate[0]!.running_balance_cents).toBe(98000); // 100k + -2k
    expect(byDate[1]!.running_balance_cents).toBe(103000); // + 5k
  });

  it('running_balance_cents is null for pre-opening transactions', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${accountId}`,
      payload: {
        opening_balance_cents: 100000,
        opening_balance_date: '2026-03-01',
      },
      headers: { 'content-type': 'application/json' },
    });
    await seedTxn(accountId, '2026-02-15', -50000); // pre-opening

    const res = await app.inject({
      method: 'GET',
      url: `/api/transactions?accountId=${accountId}`,
    });
    expect(res.json().transactions[0]!.running_balance_cents).toBeNull();
  });

  it('returns 404 PATCHing a non-existent account', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/accounts/00000000-0000-0000-0000-000000000000',
      payload: { opening_balance_cents: 1 },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(404);
  });
});
