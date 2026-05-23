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

describe('Subscriptions scan + candidates (Phase 7.5)', () => {
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

  it('falls back to rules detection when AI is not configured', async () => {
    // Three monthly Netflix charges -> one bill-kind suggestion.
    await seedTxn(accountId, '2026-03-01', -1499, 'NETFLIX.COM');
    await seedTxn(accountId, '2026-04-01', -1499, 'NETFLIX.COM');
    await seedTxn(accountId, '2026-05-01', -1499, 'NETFLIX.COM');
    // Three monthly paychecks -> income suggestion (must NOT show up).
    await seedTxn(accountId, '2026-03-15', 250000, 'PAYROLL ACME CORP');
    await seedTxn(accountId, '2026-04-15', 250000, 'PAYROLL ACME CORP');
    await seedTxn(accountId, '2026-05-15', 250000, 'PAYROLL ACME CORP');

    const r = await app.inject({
      method: 'POST',
      url: '/api/subscriptions/scan',
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ai_used).toBe(false);
    expect(body.inserted).toBe(1); // only the bill, not the income
    expect(body.reason).toMatch(/AI_PROVIDER=claude/);
  });

  it('GET /api/subscriptions/candidates returns only pending bill-kind suggestions', async () => {
    await seedTxn(accountId, '2026-03-01', -999, 'SPOTIFY USA');
    await seedTxn(accountId, '2026-04-01', -999, 'SPOTIFY USA');
    await seedTxn(accountId, '2026-05-01', -999, 'SPOTIFY USA');
    // Also seed an income-kind suggestion via the legacy detect endpoint
    // so we know the candidates list filters it out.
    await seedTxn(accountId, '2026-03-15', 250000, 'ACME PAYROLL');
    await seedTxn(accountId, '2026-04-15', 250000, 'ACME PAYROLL');
    await seedTxn(accountId, '2026-05-15', 250000, 'ACME PAYROLL');

    // Detect (covers both kinds).
    await app.inject({ method: 'POST', url: '/api/recurring/detect' });

    const r = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/candidates',
    });
    expect(r.statusCode).toBe(200);
    const candidates = r.json().candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('bill');
    expect(candidates[0].normalized_key).toMatch(/SPOTIFY/);
  });

  it('scan is idempotent — re-running does not double-insert', async () => {
    await seedTxn(accountId, '2026-03-01', -1599, 'HBOMAX');
    await seedTxn(accountId, '2026-04-01', -1599, 'HBOMAX');
    await seedTxn(accountId, '2026-05-01', -1599, 'HBOMAX');

    const first = await app.inject({
      method: 'POST',
      url: '/api/subscriptions/scan',
    });
    expect(first.json().inserted).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: '/api/subscriptions/scan',
    });
    expect(second.json().inserted).toBe(0);
  });

  it('candidates list excludes already-rejected suggestions', async () => {
    await seedTxn(accountId, '2026-03-01', -1099, 'HULU LLC');
    await seedTxn(accountId, '2026-04-01', -1099, 'HULU LLC');
    await seedTxn(accountId, '2026-05-01', -1099, 'HULU LLC');

    await app.inject({ method: 'POST', url: '/api/subscriptions/scan' });
    const list1 = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/candidates',
    });
    const id = list1.json().candidates[0].id;

    await app.inject({
      method: 'POST',
      url: `/api/recurring/suggestions/${id}/reject`,
    });

    const list2 = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/candidates',
    });
    expect(list2.json().candidates).toHaveLength(0);
  });
});
