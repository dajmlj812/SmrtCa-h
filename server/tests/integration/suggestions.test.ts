import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, pool, resetDb, seedAccount } from '../setup/test-db.js';

async function seedPendingSuggestion(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO category_suggestions (suggested_name) VALUES ($1)
     RETURNING id`,
    [name],
  );
  return r.rows[0]!.id;
}

async function seedTaggedTransaction(
  accountId: string,
  suggestedName: string,
  description: string,
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash,
        suggested_category_name, normalization_status)
     VALUES ($1, '2026-05-01', -1500, $2, $3, $4, 'normalized')
     RETURNING id`,
    [accountId, description, randomUUID(), suggestedName],
  );
  return r.rows[0]!.id;
}

describe('Suggestions API', () => {
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

  it('lists pending suggestions with the transaction count', async () => {
    const id = await seedPendingSuggestion('Pet Care');
    await seedTaggedTransaction(accountId, 'Pet Care', 'PETCO #123');
    await seedTaggedTransaction(accountId, 'Pet Care', 'CHEWY.COM');
    await seedPendingSuggestion('Yoga'); // no tagged transactions yet

    const res = await app.inject({
      method: 'GET',
      url: '/api/suggestions',
    });
    expect(res.statusCode).toBe(200);
    const { suggestions } = res.json();
    expect(suggestions).toHaveLength(2);
    const petCare = suggestions.find(
      (s: { suggested_name: string }) => s.suggested_name === 'Pet Care',
    );
    expect(petCare.id).toBe(id);
    expect(Number(petCare.transaction_count)).toBe(2);
  });

  it('approves a suggestion — creates the category and relinks transactions', async () => {
    const id = await seedPendingSuggestion('Pet Care');
    const txn1 = await seedTaggedTransaction(accountId, 'Pet Care', 'PETCO');
    const txn2 = await seedTaggedTransaction(accountId, 'Pet Care', 'CHEWY');

    const petsParent = await pool.query<{ id: string }>(
      `SELECT id FROM categories WHERE name = 'Pets'`,
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/suggestions/${id}/approve`,
      payload: { parentId: petsParent.rows[0]!.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.category.name).toBe('Pet Care');
    expect(body.category.parent_id).toBe(petsParent.rows[0]!.id);
    expect(body.transactionsRelinked).toBe(2);

    // Transactions now point at the new category.
    const rows = await pool.query<{
      id: string;
      category_id: string | null;
      suggested_category_name: string | null;
    }>(
      `SELECT id, category_id, suggested_category_name
         FROM transactions WHERE id IN ($1, $2)`,
      [txn1, txn2],
    );
    for (const row of rows.rows) {
      expect(row.category_id).toBe(body.category.id);
      expect(row.suggested_category_name).toBeNull();
    }
  });

  it('rejects a duplicate approve (suggestion name already a category)', async () => {
    const id = await seedPendingSuggestion('Subscriptions'); // already seeded
    const res = await app.inject({
      method: 'POST',
      url: `/api/suggestions/${id}/approve`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it('merges a suggestion into an existing category', async () => {
    const id = await seedPendingSuggestion('Pet Care');
    await seedTaggedTransaction(accountId, 'Pet Care', 'PETCO');

    const target = await pool.query<{ id: string }>(
      `SELECT id FROM categories WHERE name = 'Pet Supplies'`,
    );
    const targetId = target.rows[0]!.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/suggestions/${id}/merge`,
      payload: { categoryId: targetId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mergedTo.id).toBe(targetId);
    expect(body.transactionsRelinked).toBe(1);

    const sug = await pool.query<{ status: string; resolved_to_category_id: string }>(
      `SELECT status, resolved_to_category_id FROM category_suggestions WHERE id = $1`,
      [id],
    );
    expect(sug.rows[0]!.status).toBe('merged');
    expect(sug.rows[0]!.resolved_to_category_id).toBe(targetId);
  });

  it('rejects a suggestion and clears the tag on its transactions', async () => {
    const id = await seedPendingSuggestion('Pet Care');
    const txn = await seedTaggedTransaction(accountId, 'Pet Care', 'PETCO');

    const res = await app.inject({
      method: 'POST',
      url: `/api/suggestions/${id}/reject`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactionsCleared).toBe(1);

    const sug = await pool.query<{ status: string }>(
      `SELECT status FROM category_suggestions WHERE id = $1`,
      [id],
    );
    expect(sug.rows[0]!.status).toBe('rejected');

    const row = await pool.query<{ suggested_category_name: string | null }>(
      `SELECT suggested_category_name FROM transactions WHERE id = $1`,
      [txn],
    );
    expect(row.rows[0]!.suggested_category_name).toBeNull();
  });

  it('returns 404 when the suggestion is already resolved', async () => {
    const id = await seedPendingSuggestion('Pet Care');
    await app.inject({
      method: 'POST',
      url: `/api/suggestions/${id}/reject`,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/suggestions/${id}/reject`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an invalid suggestion id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/suggestions/not-a-uuid/reject',
    });
    expect(res.statusCode).toBe(400);
  });
});
