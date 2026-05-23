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
  date: string,
  amountCents: number,
  description: string,
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [accountId, date, amountCents, description, randomUUID()],
  );
  return r.rows[0]!.id;
}

describe('CSV export', () => {
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

  it('returns CSV with header and matching rows', async () => {
    await seedTxn(accountId, '2026-05-01', -1234, 'Coffee');
    await seedTxn(accountId, '2026-05-02', 50000, 'Paycheck');

    const res = await app.inject({
      method: 'GET',
      url: '/api/transactions/export',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment;.*smrtcash-transactions-\d{4}-\d{2}-\d{2}\.csv/);

    const lines = res.payload.split(/\r\n/).filter(Boolean);
    expect(lines[0]).toContain('"Date"');
    expect(lines[0]).toContain('"Amount"');
    expect(lines.length).toBe(3); // header + 2 rows
    // Amount appears as decimal, sign preserved.
    expect(lines.some((l) => l.includes('"-12.34"'))).toBe(true);
    expect(lines.some((l) => l.includes('"500.00"'))).toBe(true);
  });

  it('escapes embedded quotes and commas', async () => {
    await seedTxn(accountId, '2026-05-01', -100, 'GAS, AT 5 PM "PUMP #3"');

    const res = await app.inject({
      method: 'GET',
      url: '/api/transactions/export',
    });
    // Embedded double-quote becomes "" inside a quoted field.
    expect(res.payload).toContain(`"GAS, AT 5 PM ""PUMP #3"""`);
  });

  it('honors start/end date range', async () => {
    await seedTxn(accountId, '2026-04-15', -100, 'Older');
    await seedTxn(accountId, '2026-05-15', -100, 'In range');
    await seedTxn(accountId, '2026-06-15', -100, 'Newer');

    const res = await app.inject({
      method: 'GET',
      url: '/api/transactions/export?start=2026-05-01&end=2026-05-31',
    });
    const lines = res.payload.split(/\r\n/).filter(Boolean);
    expect(lines.length).toBe(2); // header + 1 row
    expect(res.payload).toContain('"In range"');
    expect(res.payload).not.toContain('"Older"');
    expect(res.payload).not.toContain('"Newer"');
  });

  it('rejects malformed dates', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/transactions/export?start=bad',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns header-only when no rows match', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/transactions/export',
    });
    const lines = res.payload.split(/\r\n/).filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^"Date"/);
  });
});
