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
  merchant: string,
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash,
        normalized_merchant)
     VALUES ($1, $2, $3, $4, $5, $4)
     RETURNING id`,
    [accountId, date, amountCents, merchant, randomUUID()],
  );
  return r.rows[0]!.id;
}

describe('Recurring suggestions API', () => {
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

  it('detects a monthly bill and lists it as pending', async () => {
    await seedTxn(accountId, '2026-03-01', -1499, 'Netflix');
    await seedTxn(accountId, '2026-04-01', -1499, 'Netflix');
    await seedTxn(accountId, '2026-05-01', -1499, 'Netflix');

    const detect = await app.inject({ method: 'POST', url: '/api/recurring/detect' });
    expect(detect.statusCode).toBe(200);
    expect(detect.json().inserted).toBe(1);

    const list = await app.inject({
      method: 'GET',
      url: '/api/recurring/suggestions',
    });
    const s = list.json().suggestions[0]!;
    expect(s.kind).toBe('bill');
    expect(s.detected_frequency).toBe('monthly');
    expect(s.amount_cents).toBe(1499);
    expect(s.status).toBe('pending');
  });

  it('re-running detect does not duplicate suggestions with the same key', async () => {
    await seedTxn(accountId, '2026-03-01', -1499, 'Netflix');
    await seedTxn(accountId, '2026-04-01', -1499, 'Netflix');
    await seedTxn(accountId, '2026-05-01', -1499, 'Netflix');

    await app.inject({ method: 'POST', url: '/api/recurring/detect' });
    const second = await app.inject({ method: 'POST', url: '/api/recurring/detect' });
    expect(second.json().inserted).toBe(0);

    const list = await app.inject({
      method: 'GET',
      url: '/api/recurring/suggestions',
    });
    expect(list.json().suggestions).toHaveLength(1);
  });

  it('confirm creates a bill row and links the suggestion', async () => {
    await seedTxn(accountId, '2026-03-01', -1499, 'Netflix');
    await seedTxn(accountId, '2026-04-01', -1499, 'Netflix');
    await seedTxn(accountId, '2026-05-01', -1499, 'Netflix');
    await app.inject({ method: 'POST', url: '/api/recurring/detect' });
    const list = await app.inject({ method: 'GET', url: '/api/recurring/suggestions' });
    const sug = list.json().suggestions[0]!;

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/recurring/suggestions/${sug.id}/confirm`,
      payload: { name: 'Netflix monthly', frequency: 'monthly' },
      headers: { 'content-type': 'application/json' },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().suggestion.status).toBe('confirmed');
    expect(confirm.json().resolvedId).toBeDefined();

    const bills = await app.inject({ method: 'GET', url: '/api/bills' });
    const bill = bills.json().bills.find((b: { name: string }) => b.name === 'Netflix monthly');
    expect(bill).toBeDefined();
    expect(bill.amount_cents).toBe(1499);
    expect(bill.frequency).toBe('monthly');
  });

  it('confirm on an income suggestion creates a recurring_income row', async () => {
    // Biweekly payroll.
    await seedTxn(accountId, '2026-03-06', 200000, 'PAYROLL ACME');
    await seedTxn(accountId, '2026-03-20', 200000, 'PAYROLL ACME');
    await seedTxn(accountId, '2026-04-03', 200000, 'PAYROLL ACME');
    await seedTxn(accountId, '2026-04-17', 200000, 'PAYROLL ACME');

    await app.inject({ method: 'POST', url: '/api/recurring/detect' });
    const list = await app.inject({
      method: 'GET',
      url: '/api/recurring/suggestions',
    });
    const sug = list.json().suggestions[0]!;
    expect(sug.kind).toBe('income');

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/recurring/suggestions/${sug.id}/confirm`,
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(confirm.statusCode).toBe(200);

    const income = await app.inject({
      method: 'GET',
      url: '/api/recurring-income',
    });
    expect(income.json().income).toHaveLength(1);
    expect(income.json().income[0]!.frequency).toBe('biweekly');
  });

  it('reject moves a suggestion to "rejected" and prevents re-detection', async () => {
    await seedTxn(accountId, '2026-03-01', -1499, 'Netflix');
    await seedTxn(accountId, '2026-04-01', -1499, 'Netflix');
    await seedTxn(accountId, '2026-05-01', -1499, 'Netflix');
    await app.inject({ method: 'POST', url: '/api/recurring/detect' });
    const list = await app.inject({ method: 'GET', url: '/api/recurring/suggestions' });
    const sug = list.json().suggestions[0]!;

    const rej = await app.inject({
      method: 'POST',
      url: `/api/recurring/suggestions/${sug.id}/reject`,
    });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().suggestion.status).toBe('rejected');

    // Re-running detection should skip — rejected key stays rejected.
    const detectAgain = await app.inject({
      method: 'POST',
      url: '/api/recurring/detect',
    });
    expect(detectAgain.json().inserted).toBe(0);
  });

  it('snooze keeps the suggestion eligible for confirmation later', async () => {
    await seedTxn(accountId, '2026-03-01', -1499, 'Netflix');
    await seedTxn(accountId, '2026-04-01', -1499, 'Netflix');
    await seedTxn(accountId, '2026-05-01', -1499, 'Netflix');
    await app.inject({ method: 'POST', url: '/api/recurring/detect' });
    const list = await app.inject({ method: 'GET', url: '/api/recurring/suggestions' });
    const sug = list.json().suggestions[0]!;

    const snz = await app.inject({
      method: 'POST',
      url: `/api/recurring/suggestions/${sug.id}/snooze`,
    });
    expect(snz.json().suggestion.status).toBe('snoozed');

    // Confirm still works on a snoozed suggestion.
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/recurring/suggestions/${sug.id}/confirm`,
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(confirm.statusCode).toBe(200);
  });

  it('excludes transfer transactions from detection', async () => {
    const otherAcct = await seedAccount({ name: 'Savings', type: 'savings' });
    const groupId = randomUUID();
    // Insert paired-transfer rows that look monthly.
    for (const date of ['2026-03-01', '2026-04-01', '2026-05-01']) {
      await pool.query(
        `INSERT INTO transactions
           (account_id, txn_date, amount_cents, raw_description, dedup_hash, transfer_group_id)
         VALUES ($1, $2, -50000, 'XFER', $3, $4),
                ($5, $2, 50000, 'XFER', $6, $4)`,
        [
          accountId,
          date,
          randomUUID(),
          groupId,
          otherAcct,
          randomUUID(),
        ],
      );
    }
    const detect = await app.inject({ method: 'POST', url: '/api/recurring/detect' });
    expect(detect.json().inserted).toBe(0);
  });
});
