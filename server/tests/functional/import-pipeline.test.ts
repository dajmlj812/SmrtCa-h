import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { commitImport, previewImport } from '../../src/import/importer.js';
import { makeTestApp, resetDb, seedAccount, pool } from '../setup/test-db.js';
import { fixtureBuffer } from '../setup/fixtures.js';

/**
 * Functional tests — assert specific business outcomes (exact counts and
 * balances) defined by the product, not just that the parts interact.
 */
describe('Import pipeline (functional)', () => {
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

  async function accountBalance(accountId: string): Promise<number> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${accountId}`,
    });
    return res.json().account.balance_cents;
  }

  async function transactionCount(accountId: string): Promise<number> {
    const r = await pool.query<{ c: number }>(
      'SELECT COUNT(*)::int AS c FROM transactions WHERE account_id = $1',
      [accountId],
    );
    return r.rows[0]!.c;
  }

  it('imports a Chase credit-card statement with the exact count and balance', async () => {
    const accountId = await seedAccount({ type: 'credit_card' });
    const result = await commitImport(
      accountId,
      'cc.csv',
      fixtureBuffer('chase-credit-card.csv'),
    );
    expect(result.importedCount).toBe(8);
    expect(result.errorCount).toBe(0);
    expect(await transactionCount(accountId)).toBe(8);
    // 500.00 - 4.50 - 15.99 - 87.32 - 45.00 - 4.50 - 95.00 + 12.99 = 260.68
    expect(await accountBalance(accountId)).toBe(26068);
  });

  it('imports a Chase bank statement and preserves running balances', async () => {
    const accountId = await seedAccount({ type: 'checking' });
    const result = await commitImport(
      accountId,
      'bank.csv',
      fixtureBuffer('chase-bank.csv'),
    );
    expect(result.importedCount).toBe(5);
    // -100 + 2000 - 75.50 - 120 + 0.25 = 1704.75
    expect(await accountBalance(accountId)).toBe(170475);

    const nullBalances = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM transactions
       WHERE account_id = $1 AND balance_cents IS NULL`,
      [accountId],
    );
    // The pending transfer row had a blank Balance cell.
    expect(nullBalances.rows[0]!.c).toBe(1);
  });

  it('applies a custom column mapping with separate debit/credit columns', async () => {
    const accountId = await seedAccount();
    const result = await commitImport(
      accountId,
      'generic.csv',
      fixtureBuffer('generic-bank.csv'),
      undefined,
      {
        txnDate: 'Date',
        description: 'Memo',
        debit: 'Withdrawal',
        credit: 'Deposit',
        balance: 'Running Balance',
      },
    );
    expect(result.importedCount).toBe(3);
    // -23.45 + 1500.00 - 12.00 = 1464.55
    expect(await accountBalance(accountId)).toBe(146455);
  });

  it('imports valid rows and reports the bad ones', async () => {
    const accountId = await seedAccount();
    const result = await commitImport(
      accountId,
      'malformed.csv',
      fixtureBuffer('malformed.csv'),
    );
    expect(result.importedCount).toBe(2);
    expect(result.errorCount).toBe(2);
    expect(result.errors[0]!.rowNumber).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toBeTruthy();
  });

  it('keeps genuinely identical rows but skips a re-import', async () => {
    const accountId = await seedAccount();
    const first = await commitImport(
      accountId,
      'identical.csv',
      fixtureBuffer('identical-rows.csv'),
    );
    expect(first.importedCount).toBe(2);

    const second = await commitImport(
      accountId,
      'identical.csv',
      fixtureBuffer('identical-rows.csv'),
    );
    expect(second.importedCount).toBe(0);
    expect(second.skippedCount).toBe(2);
    expect(await transactionCount(accountId)).toBe(2);
  });

  it('treats a header-only file as zero transactions', async () => {
    const accountId = await seedAccount();
    const result = await commitImport(
      accountId,
      'empty.csv',
      fixtureBuffer('header-only.csv'),
    );
    expect(result.importedCount).toBe(0);
    expect(result.errorCount).toBe(0);
  });

  it('preview parses without persisting anything', async () => {
    const accountId = await seedAccount();
    const preview = await previewImport(
      'cc.csv',
      fixtureBuffer('chase-credit-card.csv'),
    );
    expect(preview.parsedCount).toBe(8);
    expect(await transactionCount(accountId)).toBe(0);
  });

  it('rejects a commit when the format cannot be detected', async () => {
    const accountId = await seedAccount();
    await expect(
      commitImport(
        accountId,
        'unknown.csv',
        fixtureBuffer('unknown-format.csv'),
      ),
    ).rejects.toThrow();
  });
});
