import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { commitImport } from '../../src/import/importer.js';
import { normalizePending } from '../../src/ai/normalize-service.js';
import { makeTestApp, pool, resetDb, seedAccount } from '../setup/test-db.js';
import { fixtureBuffer } from '../setup/fixtures.js';

/**
 * Functional test for the normalization pipeline. Runs against the configured
 * AI provider (defaults to `rules` per .env), which is deterministic.
 */
describe('Normalization pipeline (functional)', () => {
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

  it('normalizes every pending row from an import', async () => {
    const accountId = await seedAccount({ type: 'credit_card' });
    await commitImport(
      accountId,
      'cc.csv',
      fixtureBuffer('chase-credit-card.csv'),
    );

    const summary = await normalizePending({ accountId });
    expect(summary.processed).toBe(8);
    expect(summary.normalized).toBe(8);
    expect(summary.errors).toBe(0);

    const rows = await pool.query<{
      normalized_merchant: string | null;
      normalization_status: string;
      category_id: string | null;
    }>(
      `SELECT normalized_merchant, normalization_status, category_id
         FROM transactions
        WHERE account_id = $1`,
      [accountId],
    );
    expect(rows.rows).toHaveLength(8);
    for (const r of rows.rows) {
      expect(r.normalization_status).toBe('normalized');
      expect(r.normalized_merchant).not.toBeNull();
      expect(r.category_id).not.toBeNull();
    }
  });

  it('does not re-normalize rows that the user has manually edited', async () => {
    const accountId = await seedAccount({ type: 'credit_card' });
    await commitImport(
      accountId,
      'cc.csv',
      fixtureBuffer('chase-credit-card.csv'),
    );

    // Mark one row as manually edited; pretend the user picked Income.
    const incomeId = (
      await pool.query<{ id: string }>(
        `SELECT id FROM categories WHERE name = 'Income'`,
      )
    ).rows[0]!.id;
    const targetTxn = (
      await pool.query<{ id: string }>(
        `SELECT id FROM transactions WHERE account_id = $1 LIMIT 1`,
        [accountId],
      )
    ).rows[0]!.id;
    await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${targetTxn}`,
      payload: { categoryId: incomeId },
    });

    const summary = await normalizePending({ accountId });
    // Only 7 left pending — the manual one is preserved.
    expect(summary.processed).toBe(7);

    const manualRow = await pool.query<{
      normalization_status: string;
      category_id: string | null;
    }>(
      `SELECT normalization_status, category_id FROM transactions WHERE id = $1`,
      [targetTxn],
    );
    expect(manualRow.rows[0]!.normalization_status).toBe('manual');
    expect(manualRow.rows[0]!.category_id).toBe(incomeId);
  });
});
