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
  txnDate: string,
  amountCents: number,
  description = 'Test',
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [accountId, txnDate, amountCents, description, randomUUID()],
  );
  return result.rows[0]!.id;
}

describe('Transfers API', () => {
  let app: FastifyInstance;
  let checking: string;
  let savings: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    checking = await seedAccount({ name: 'Checking', type: 'checking' });
    savings = await seedAccount({ name: 'Savings', type: 'savings' });
  });

  it('pairs equal-opposite amounts on different accounts within the date window', async () => {
    const debit = await seedTxn(checking, '2026-05-01', -50000, 'Transfer out');
    const credit = await seedTxn(savings, '2026-05-02', 50000, 'Transfer in');

    const res = await app.inject({
      method: 'POST',
      url: '/api/transfers/detect',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const { summary } = res.json();
    expect(summary.paired).toBe(1);
    expect(summary.scanned).toBe(1);

    // Both rows now share a group_id.
    const result = await pool.query<{ transfer_group_id: string | null }>(
      'SELECT transfer_group_id FROM transactions WHERE id = ANY($1::uuid[])',
      [[debit, credit]],
    );
    const groups = result.rows.map((r) => r.transfer_group_id);
    expect(groups[0]).not.toBeNull();
    expect(groups[0]).toBe(groups[1]);
  });

  it('does not pair same-amount-same-sign transactions', async () => {
    await seedTxn(checking, '2026-05-01', 50000, 'Refund');
    await seedTxn(savings, '2026-05-01', 50000, 'Deposit');

    const res = await app.inject({
      method: 'POST',
      url: '/api/transfers/detect',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(res.json().summary.paired).toBe(0);
  });

  it('does not pair across more than 5 days', async () => {
    await seedTxn(checking, '2026-05-01', -50000);
    await seedTxn(savings, '2026-05-10', 50000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/transfers/detect',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(res.json().summary.paired).toBe(0);
  });

  it('does not pair two transactions on the same account', async () => {
    await seedTxn(checking, '2026-05-01', -50000);
    await seedTxn(checking, '2026-05-01', 50000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/transfers/detect',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(res.json().summary.paired).toBe(0);
  });

  it('picks the closer-date match when two candidates exist', async () => {
    // One debit, two potential credit candidates at different distances.
    const debit = await seedTxn(checking, '2026-05-01', -50000);
    const farCredit = await seedTxn(savings, '2026-05-05', 50000);
    const nearCredit = await seedTxn(savings, '2026-05-02', 50000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/transfers/detect',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(res.json().summary.paired).toBe(1);

    const result = await pool.query<{ id: string; transfer_group_id: string | null }>(
      'SELECT id, transfer_group_id FROM transactions WHERE id = ANY($1::uuid[])',
      [[debit, nearCredit, farCredit]],
    );
    const byId = new Map(result.rows.map((r) => [r.id, r.transfer_group_id]));
    expect(byId.get(debit)).not.toBeNull();
    expect(byId.get(nearCredit)).toBe(byId.get(debit));
    expect(byId.get(farCredit)).toBeNull();
  });

  it('skips already-paired rows on a re-run', async () => {
    await seedTxn(checking, '2026-05-01', -50000);
    await seedTxn(savings, '2026-05-01', 50000);

    await app.inject({
      method: 'POST',
      url: '/api/transfers/detect',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/transfers/detect',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(second.json().summary.paired).toBe(0);
    expect(second.json().summary.scanned).toBe(0);
  });

  it('lists detected transfer groups via GET /api/transfers', async () => {
    await seedTxn(checking, '2026-05-01', -50000, 'OUT');
    await seedTxn(savings, '2026-05-01', 50000, 'IN');
    await app.inject({ method: 'POST', url: '/api/transfers/detect', payload: {}, headers: { 'content-type': 'application/json' } });

    const res = await app.inject({ method: 'GET', url: '/api/transfers' });
    expect(res.statusCode).toBe(200);
    const { transfers } = res.json();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].transactions).toHaveLength(2);
    const names = transfers[0].transactions.map((t: { account_name: string }) => t.account_name).sort();
    expect(names).toEqual(['Checking', 'Savings']);
  });

  it('unlinks a transfer group, clearing both transactions', async () => {
    const debit = await seedTxn(checking, '2026-05-01', -50000);
    const credit = await seedTxn(savings, '2026-05-01', 50000);
    await app.inject({ method: 'POST', url: '/api/transfers/detect', payload: {}, headers: { 'content-type': 'application/json' } });
    const list = await app.inject({ method: 'GET', url: '/api/transfers' });
    const groupId = list.json().transfers[0].group_id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/transfers/${groupId}`,
    });
    expect(del.statusCode).toBe(204);

    const after = await pool.query<{ transfer_group_id: string | null }>(
      'SELECT transfer_group_id FROM transactions WHERE id = ANY($1::uuid[])',
      [[debit, credit]],
    );
    expect(after.rows.every((r) => r.transfer_group_id === null)).toBe(true);
  });

  it('manually links two transactions even without matching amounts', async () => {
    // E.g. transfer with a $1 wire fee → -10000 sent, +9900 received.
    const debit = await seedTxn(checking, '2026-05-01', -10000, 'Wire out');
    const credit = await seedTxn(savings, '2026-05-02', 9900, 'Wire in net of fee');

    const res = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { aId: debit, bId: credit },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    const { groupId } = res.json();
    expect(groupId).toBeTruthy();

    const after = await pool.query<{ transfer_group_id: string | null }>(
      'SELECT transfer_group_id FROM transactions WHERE id = ANY($1::uuid[])',
      [[debit, credit]],
    );
    expect(after.rows.every((r) => r.transfer_group_id === groupId)).toBe(true);
  });

  it('refuses to link two transactions on the same account', async () => {
    const a = await seedTxn(checking, '2026-05-01', -10000);
    const b = await seedTxn(checking, '2026-05-01', 10000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { aId: a, bId: b },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/same account/i);
  });

  it('returns 400 for malformed link payloads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { aId: 'not-a-uuid', bId: 'also-not' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 unlinking a non-existent group', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/transfers/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('scopes detection to a single account when accountId is supplied', async () => {
    const third = await seedAccount({ name: 'CreditCard', type: 'credit_card' });
    // Pair 1: checking <-> savings.
    await seedTxn(checking, '2026-05-01', -50000);
    await seedTxn(savings, '2026-05-01', 50000);
    // Pair 2: savings <-> third — should be IGNORED when filtered to checking.
    await seedTxn(savings, '2026-05-15', -20000);
    await seedTxn(third, '2026-05-15', 20000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/transfers/detect',
      payload: { accountId: checking },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.json().summary.paired).toBe(1);
  });
});
