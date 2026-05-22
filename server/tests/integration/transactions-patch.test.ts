import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, pool, resetDb, seedAccount } from '../setup/test-db.js';

describe('PATCH /api/transactions/:id', () => {
  let app: FastifyInstance;
  let accountId: string;
  let txnId: string;
  let categoryId: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb();
    accountId = await seedAccount();

    const txn = await pool.query<{ id: string }>(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-05-01', -100, 'COFFEE', $2)
       RETURNING id`,
      [accountId, randomUUID()],
    );
    txnId = txn.rows[0]!.id;

    const cat = await pool.query<{ id: string }>(
      `SELECT id FROM categories WHERE name = 'Dining & Restaurants'`,
    );
    categoryId = cat.rows[0]!.id;
  });

  it('sets the category and marks the row as manual', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txnId}`,
      payload: { categoryId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction.category_id).toBe(categoryId);
    expect(res.json().transaction.normalization_status).toBe('manual');
  });

  it('clears the category when null is supplied', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txnId}`,
      payload: { categoryId },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txnId}`,
      payload: { categoryId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction.category_id).toBeNull();
  });

  it('rejects a body with no updatable fields', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txnId}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed categoryId', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txnId}`,
      payload: { categoryId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown transaction', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transactions/00000000-0000-0000-0000-000000000000',
      payload: { categoryId },
    });
    expect(res.statusCode).toBe(404);
  });
});
