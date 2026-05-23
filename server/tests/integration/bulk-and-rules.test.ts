import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  pool,
  resetDb,
  seedAccount,
} from '../setup/test-db.js';

async function seedTxn(opts: {
  accountId: string;
  date: string;
  amountCents: number;
  raw: string;
  merchant?: string | null;
  categoryId?: string | null;
  status?: string;
}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash,
        normalized_merchant, category_id, normalization_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      opts.accountId,
      opts.date,
      opts.amountCents,
      opts.raw,
      randomUUID(),
      opts.merchant ?? null,
      opts.categoryId ?? null,
      opts.status ?? 'pending',
    ],
  );
  return r.rows[0]!.id;
}

async function categoryId(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM categories WHERE lower(name) = lower($1) LIMIT 1`,
    [name],
  );
  return r.rows[0]!.id;
}

describe('Bulk edit + normalization rules + splits', () => {
  let app: FastifyInstance;
  let accountId: string;
  let groceries: string;
  let restaurants: string;

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
    restaurants = await categoryId('Restaurants');
  });

  describe('PATCH /api/transactions/bulk', () => {
    it('updates the category on every supplied id', async () => {
      const a = await seedTxn({ accountId, date: '2026-05-01', amountCents: -100, raw: 'A' });
      const b = await seedTxn({ accountId, date: '2026-05-02', amountCents: -200, raw: 'B' });
      const c = await seedTxn({ accountId, date: '2026-05-03', amountCents: -300, raw: 'C' });

      const r = await app.inject({
        method: 'PATCH',
        url: '/api/transactions/bulk',
        payload: {
          ids: [a, b, c],
          updates: { categoryId: groceries },
        },
        headers: { 'content-type': 'application/json' },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().updated).toBe(3);

      const check = await pool.query<{ category_id: string; normalization_status: string }>(
        `SELECT category_id, normalization_status FROM transactions
          WHERE id = ANY($1::uuid[])`,
        [[a, b, c]],
      );
      expect(check.rows.every((row) => row.category_id === groceries)).toBe(true);
      expect(check.rows.every((row) => row.normalization_status === 'manual')).toBe(true);
    });

    it('also sets merchant when supplied', async () => {
      const a = await seedTxn({ accountId, date: '2026-05-01', amountCents: -100, raw: 'X' });
      await app.inject({
        method: 'PATCH',
        url: '/api/transactions/bulk',
        payload: { ids: [a], updates: { merchant: 'ONSTAR' } },
        headers: { 'content-type': 'application/json' },
      });
      const r = await pool.query<{ normalized_merchant: string }>(
        `SELECT normalized_merchant FROM transactions WHERE id = $1`,
        [a],
      );
      expect(r.rows[0]!.normalized_merchant).toBe('ONSTAR');
    });

    it('rejects an invalid id', async () => {
      const r = await app.inject({
        method: 'PATCH',
        url: '/api/transactions/bulk',
        payload: { ids: ['not-a-uuid'], updates: { categoryId: groceries } },
        headers: { 'content-type': 'application/json' },
      });
      expect(r.statusCode).toBe(400);
    });

    it('rejects empty ids', async () => {
      const r = await app.inject({
        method: 'PATCH',
        url: '/api/transactions/bulk',
        payload: { ids: [], updates: { categoryId: groceries } },
        headers: { 'content-type': 'application/json' },
      });
      expect(r.statusCode).toBe(400);
    });
  });

  describe('normalization rules', () => {
    it('creates a rule, then preview reports the matching transaction count', async () => {
      await seedTxn({
        accountId,
        date: '2026-05-01',
        amountCents: -1500,
        raw: 'POS DEBIT ONSTAR, LLC 888-4667827 MI 0408',
      });
      await seedTxn({
        accountId,
        date: '2026-06-01',
        amountCents: -1500,
        raw: 'ONSTAR LLC AUTOPAY',
      });
      await seedTxn({
        accountId,
        date: '2026-05-05',
        amountCents: -2500,
        raw: 'TRADER JOES #523',
      });

      const create = await app.inject({
        method: 'POST',
        url: '/api/normalization-rules',
        payload: { pattern: 'ONSTAR', normalizedMerchant: 'OnStar' },
        headers: { 'content-type': 'application/json' },
      });
      expect(create.statusCode).toBe(201);

      const preview = await app.inject({
        method: 'POST',
        url: '/api/normalization-rules/preview',
        payload: { pattern: 'ONSTAR' },
        headers: { 'content-type': 'application/json' },
      });
      expect(preview.json().total).toBe(2);
    });

    it('apply updates non-manual transactions, skips manual ones by default', async () => {
      const a = await seedTxn({
        accountId,
        date: '2026-05-01',
        amountCents: -1500,
        raw: 'POS DEBIT ONSTAR, LLC ...',
      });
      const b = await seedTxn({
        accountId,
        date: '2026-06-01',
        amountCents: -1500,
        raw: 'ONSTAR LLC AUTOPAY',
        status: 'manual',
        merchant: 'My Custom Name',
      });

      await app.inject({
        method: 'POST',
        url: '/api/normalization-rules',
        payload: { pattern: 'ONSTAR', normalizedMerchant: 'OnStar' },
        headers: { 'content-type': 'application/json' },
      });
      const apply = await app.inject({
        method: 'POST',
        url: '/api/normalization-rules/apply',
        payload: {},
        headers: { 'content-type': 'application/json' },
      });
      expect(apply.json().totalUpdated).toBe(1);

      const rows = await pool.query<{ id: string; normalized_merchant: string }>(
        `SELECT id, normalized_merchant FROM transactions WHERE id = ANY($1::uuid[])`,
        [[a, b]],
      );
      const byId = new Map(rows.rows.map((r) => [r.id, r.normalized_merchant]));
      expect(byId.get(a)).toBe('OnStar');
      // Manual edit preserved.
      expect(byId.get(b)).toBe('My Custom Name');
    });

    it('apply with includeManual:true overrides manual edits', async () => {
      await seedTxn({
        accountId,
        date: '2026-06-01',
        amountCents: -1500,
        raw: 'ONSTAR LLC AUTOPAY',
        status: 'manual',
        merchant: 'Junk',
      });
      await app.inject({
        method: 'POST',
        url: '/api/normalization-rules',
        payload: { pattern: 'ONSTAR', normalizedMerchant: 'OnStar' },
        headers: { 'content-type': 'application/json' },
      });
      const apply = await app.inject({
        method: 'POST',
        url: '/api/normalization-rules/apply',
        payload: { includeManual: true },
        headers: { 'content-type': 'application/json' },
      });
      expect(apply.json().totalUpdated).toBe(1);
    });

    it('refuses a duplicate pattern (case-insensitive)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/normalization-rules',
        payload: { pattern: 'ONSTAR', normalizedMerchant: 'OnStar' },
        headers: { 'content-type': 'application/json' },
      });
      const dup = await app.inject({
        method: 'POST',
        url: '/api/normalization-rules',
        payload: { pattern: 'onstar', normalizedMerchant: 'On Star' },
        headers: { 'content-type': 'application/json' },
      });
      expect(dup.statusCode).toBe(409);
    });

    it('refuses a no-op rule (no merchant AND no category)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/normalization-rules',
        payload: { pattern: 'foo' },
        headers: { 'content-type': 'application/json' },
      });
      expect(r.statusCode).toBe(400);
    });
  });

  describe('transaction splits', () => {
    it('PUT replaces splits and rejects if amounts do not sum to txn.amount', async () => {
      const txn = await seedTxn({
        accountId,
        date: '2026-05-01',
        amountCents: -10000,
        raw: 'COSTCO',
      });
      const bad = await app.inject({
        method: 'PUT',
        url: `/api/transactions/${txn}/splits`,
        payload: {
          splits: [
            { categoryId: groceries, amountCents: -4000 },
            { categoryId: restaurants, amountCents: -3000 },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/sum/);

      const good = await app.inject({
        method: 'PUT',
        url: `/api/transactions/${txn}/splits`,
        payload: {
          splits: [
            { categoryId: groceries, amountCents: -6000, memo: 'Groceries' },
            { categoryId: restaurants, amountCents: -4000, memo: 'Hot food' },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });
      expect(good.statusCode).toBe(200);
      expect(good.json().splits).toHaveLength(2);
    });

    it('empty splits array clears any existing splits', async () => {
      const txn = await seedTxn({
        accountId,
        date: '2026-05-01',
        amountCents: -10000,
        raw: 'X',
      });
      await app.inject({
        method: 'PUT',
        url: `/api/transactions/${txn}/splits`,
        payload: {
          splits: [{ categoryId: groceries, amountCents: -10000 }],
        },
        headers: { 'content-type': 'application/json' },
      });
      const clear = await app.inject({
        method: 'PUT',
        url: `/api/transactions/${txn}/splits`,
        payload: { splits: [] },
        headers: { 'content-type': 'application/json' },
      });
      expect(clear.statusCode).toBe(200);
      expect(clear.json().splits).toHaveLength(0);
    });

    it('insights spending-by-category respects splits', async () => {
      const txn = await seedTxn({
        accountId,
        date: '2026-05-01',
        amountCents: -10000,
        raw: 'COSTCO',
        categoryId: groceries, // would normally count as $100 Groceries
      });
      await app.inject({
        method: 'PUT',
        url: `/api/transactions/${txn}/splits`,
        payload: {
          splits: [
            { categoryId: groceries, amountCents: -6000 },
            { categoryId: restaurants, amountCents: -4000 },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });
      const r = await app.inject({
        method: 'GET',
        url: '/api/insights/spending-by-category?start=2026-05-01&end=2026-05-31',
      });
      const rows = r.json().rows as Array<{ category_id: string; total_cents: number }>;
      const groc = rows.find((x) => x.category_id === groceries);
      const rest = rows.find((x) => x.category_id === restaurants);
      expect(groc?.total_cents).toBe(6000);
      expect(rest?.total_cents).toBe(4000);
    });
  });

  describe('bulk recurring-suggestion actions', () => {
    async function seedSuggestion(name: string, amount: number, freq: string) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO recurring_suggestions
           (kind, name, normalized_key, amount_cents, detected_frequency,
            sample_txn_ids, confidence)
         VALUES ('bill', $1, $1, $2, $3, ARRAY[]::uuid[], 0.9)
         RETURNING id`,
        [name, amount, freq],
      );
      return r.rows[0]!.id;
    }

    it('bulk-rejects without touching pending entries', async () => {
      const a = await seedSuggestion('Sub A', 999, 'monthly');
      const b = await seedSuggestion('Sub B', 1999, 'monthly');
      const r = await app.inject({
        method: 'POST',
        url: '/api/recurring/suggestions/bulk',
        payload: { ids: [a, b], action: 'reject' },
        headers: { 'content-type': 'application/json' },
      });
      expect(r.json().updated).toBe(2);
    });

    it('bulk-confirms — but each needs a derivable next date (samples)', async () => {
      // Confirm path requires sample txns; without them deriveNextDate
      // returns null and the suggestion is skipped.
      const txn = await seedTxn({
        accountId,
        date: '2026-04-15',
        amountCents: -2500,
        raw: 'NETFLIX',
      });
      const r = await pool.query<{ id: string }>(
        `INSERT INTO recurring_suggestions
           (kind, name, normalized_key, amount_cents, detected_frequency,
            sample_txn_ids, confidence)
         VALUES ('bill', 'Netflix', 'NETFLIX', 1499, 'monthly',
                 ARRAY[$1::uuid], 0.9)
         RETURNING id`,
        [txn],
      );
      const sugId = r.rows[0]!.id;
      const bulk = await app.inject({
        method: 'POST',
        url: '/api/recurring/suggestions/bulk',
        payload: { ids: [sugId], action: 'confirm' },
        headers: { 'content-type': 'application/json' },
      });
      expect(bulk.json().confirmed).toBe(1);
      const bills = await app.inject({ method: 'GET', url: '/api/bills' });
      expect(bills.json().bills).toHaveLength(1);
    });
  });
});
