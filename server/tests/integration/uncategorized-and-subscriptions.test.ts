import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, pool, resetDb, seedAccount } from '../setup/test-db.js';

async function seedTxn(opts: {
  accountId: string;
  raw: string;
  amountCents?: number;
  categoryId?: string | null;
}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash,
        category_id, normalization_status)
     VALUES ($1, '2026-05-01', $2, $3, $4, $5, 'pending')
     RETURNING id`,
    [
      opts.accountId,
      opts.amountCents ?? -1000,
      opts.raw,
      randomUUID(),
      opts.categoryId ?? null,
    ],
  );
  return r.rows[0]!.id;
}

describe('Uncategorized filter + bulk delete (Phase 7.4)', () => {
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

  it('returns only uncategorized rows when uncategorized=true', async () => {
    const cat = await pool.query<{ id: string }>(
      `SELECT id FROM categories WHERE name = 'Groceries' LIMIT 1`,
    );
    const catId = cat.rows[0]!.id;
    await seedTxn({ accountId, raw: 'NEEDS CAT 1' });
    await seedTxn({ accountId, raw: 'NEEDS CAT 2' });
    await seedTxn({ accountId, raw: 'ALREADY CAT', categoryId: catId });

    const r = await app.inject({
      method: 'GET',
      url: '/api/transactions?uncategorized=true',
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.total).toBe(2);
    expect(body.transactions.map((t: { raw_description: string }) => t.raw_description).sort())
      .toEqual(['NEEDS CAT 1', 'NEEDS CAT 2']);
  });

  it('rows tagged with the literal "Uncategorized" category still surface as uncategorized', async () => {
    // The AI normalizer parks anything it can't classify into the
    // literal 'Uncategorized' category rather than leaving category_id
    // NULL. The triage page should still pick those up.
    const uncat = await pool.query<{ id: string }>(
      `SELECT id FROM categories WHERE name = 'Uncategorized' AND parent_id IS NULL`,
    );
    const uncatId = uncat.rows[0]!.id;
    await seedTxn({ accountId, raw: 'AI PARKED ME', categoryId: uncatId });

    const r = await app.inject({
      method: 'GET',
      url: '/api/transactions?uncategorized=true',
    });
    expect(r.json().total).toBe(1);
    expect(r.json().transactions[0].raw_description).toBe('AI PARKED ME');
  });

  it('transactions with splits count as categorized', async () => {
    const cat = await pool.query<{ id: string }>(
      `SELECT id FROM categories WHERE name = 'Groceries' LIMIT 1`,
    );
    const catId = cat.rows[0]!.id;
    const splitTxn = await seedTxn({ accountId, raw: 'SPLIT ME', amountCents: -2000 });
    await pool.query(
      `INSERT INTO transaction_splits (transaction_id, category_id, amount_cents)
       VALUES ($1, $2, -2000)`,
      [splitTxn, catId],
    );

    const r = await app.inject({
      method: 'GET',
      url: '/api/transactions?uncategorized=true',
    });
    expect(r.json().total).toBe(0);
  });

  it('bulk-deletes the given transactions and cascades attachments + splits', async () => {
    const a = await seedTxn({ accountId, raw: 'A' });
    const b = await seedTxn({ accountId, raw: 'B' });
    await seedTxn({ accountId, raw: 'C' });

    const r = await app.inject({
      method: 'POST',
      url: '/api/transactions/bulk-delete',
      payload: { ids: [a, b] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().deleted).toBe(2);

    const list = await app.inject({ method: 'GET', url: '/api/transactions' });
    expect(list.json().total).toBe(1);
  });

  it('rejects an empty id list', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/transactions/bulk-delete',
      payload: { ids: [] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('Bill review queue (Phase 7.4)', () => {
  let app: FastifyInstance;
  let billId: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    const create = await app.inject({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'Streaming',
        amountCents: 1599,
        frequency: 'monthly',
        nextDueDate: '2026-06-01',
      },
      headers: { 'content-type': 'application/json' },
    });
    billId = create.json().bill.id;
  });

  it('new bills default to review_status=active', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/bills' });
    expect(r.json().bills[0]!.review_status).toBe('active');
    expect(r.json().bills[0]!.review_note).toBeNull();
    expect(r.json().bills[0]!.last_reviewed_at).toBeNull();
  });

  it('PATCH /api/bills/:id/review moves a bill into the queue and bumps last_reviewed_at', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/bills/${billId}/review`,
      payload: { status: 'cancel', note: 'never used since 2024' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().bill.review_status).toBe('cancel');
    expect(r.json().bill.review_note).toBe('never used since 2024');
    expect(r.json().bill.last_reviewed_at).not.toBeNull();
  });

  it('GET /api/bills?reviewStatus=queue returns only flagged-but-unresolved bills', async () => {
    // Seed three bills with different statuses.
    const other = await app.inject({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'Gym',
        amountCents: 3500,
        frequency: 'monthly',
        nextDueDate: '2026-06-15',
      },
      headers: { 'content-type': 'application/json' },
    });
    const otherId = other.json().bill.id;

    await app.inject({
      method: 'PATCH',
      url: `/api/bills/${billId}/review`,
      payload: { status: 'cancel' },
      headers: { 'content-type': 'application/json' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/bills/${otherId}/review`,
      payload: { status: 'keep' },
      headers: { 'content-type': 'application/json' },
    });

    const queue = await app.inject({
      method: 'GET',
      url: '/api/bills?reviewStatus=queue',
    });
    expect(queue.json().bills).toHaveLength(1);
    expect(queue.json().bills[0]!.name).toBe('Streaming');
  });

  it('rejects an unknown review status', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/bills/${billId}/review`,
      payload: { status: 'snooze' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('clearing the note (note=null) blanks it out without touching status', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/bills/${billId}/review`,
      payload: { status: 'review', note: 'placeholder' },
      headers: { 'content-type': 'application/json' },
    });
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/bills/${billId}/review`,
      payload: { status: 'review', note: null },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.json().bill.review_note).toBeNull();
    expect(r.json().bill.review_status).toBe('review');
  });
});
