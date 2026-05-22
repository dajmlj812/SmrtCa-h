import { describe, it, expect, beforeEach } from 'vitest';
import { commitImport } from '../../src/import/importer.js';
import { resetDb, seedAccount, pool } from '../setup/test-db.js';

/** Generate a Chase-credit-card CSV with `rows` unique transactions. */
function generateCreditCardCsv(rows: number): Buffer {
  const lines = [
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
  ];
  for (let i = 0; i < rows; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const amount = ((i % 900) + 1).toString();
    lines.push(
      `05/${day}/2026,05/${day}/2026,MERCHANT NUMBER ${i},Shopping,Sale,-${amount}.99,`,
    );
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Performance tests — verify the import pipeline stays correct and fast
 * under a realistic large workload. The time budgets are deliberately
 * generous so they catch catastrophic regressions without flaking.
 */
describe('Import performance', () => {
  const ROW_COUNT = 5_000;

  beforeEach(async () => {
    await resetDb();
  });

  it(`imports ${ROW_COUNT} transactions correctly and within budget`, async () => {
    const accountId = await seedAccount();
    const csv = generateCreditCardCsv(ROW_COUNT);

    const start = performance.now();
    const result = await commitImport(accountId, 'large.csv', csv);
    const elapsedMs = performance.now() - start;

    console.log(
      `  ↳ imported ${result.importedCount} rows in ${elapsedMs.toFixed(0)}ms`,
    );
    expect(result.importedCount).toBe(ROW_COUNT);
    expect(result.errorCount).toBe(0);
    expect(elapsedMs).toBeLessThan(30_000);
  });

  it('queries a page from a large table quickly', async () => {
    const accountId = await seedAccount();
    await commitImport(
      accountId,
      'large.csv',
      generateCreditCardCsv(ROW_COUNT),
    );

    const start = performance.now();
    const res = await pool.query(
      `SELECT * FROM transactions
       WHERE account_id = $1
       ORDER BY txn_date DESC
       LIMIT 100`,
      [accountId],
    );
    const elapsedMs = performance.now() - start;

    console.log(
      `  ↳ queried 100 of ${ROW_COUNT} rows in ${elapsedMs.toFixed(0)}ms`,
    );
    expect(res.rows).toHaveLength(100);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
