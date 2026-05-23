import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';

/**
 * Phase 9.2 (0.12.2) — bill-splitting / shared expenses.
 *
 * Sign convention test: shareCents > 0 means the participant owes
 * the tenant. For a SPENDING transaction (amount_cents < 0), the
 * shares should also be < 0 — the participant owes you negative cents,
 * which equals "they owe you" in the API's convention. Wait — that
 * doesn't match. Let me re-read the route. The route enforces
 * "sign matches the transaction's sign": for a -10000 dinner, each
 * participant's share is negative. The summary then sums those
 * negatives, and the UI inverts the display ("they owe you $X").
 *
 * That's confusing but it preserves an invariant: sum(shares) bounded
 * by abs(txn.amount_cents). The tests below use that convention.
 */

async function seedTxn(accountId: string, amount: number, desc = 'TEST'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
     VALUES ($1, '2026-05-01', $2, $3, $4) RETURNING id`,
    [accountId, amount, desc, `hash-${Math.random()}`],
  );
  return r.rows[0]!.id;
}

describe('Bill splitting (0.12.2)', () => {
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

  it('participant CRUD round-trips with tenant scoping', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/split-participants',
      payload: { name: 'Alex', email: 'alex@example.com' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().participant.id;

    const list = await app.inject({
      method: 'GET',
      url: '/api/split-participants',
    });
    expect(list.json().participants).toHaveLength(1);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/split-participants/${id}`,
      payload: { name: 'Alex (roommate)' },
      headers: { 'content-type': 'application/json' },
    });
    expect(patch.json().participant.name).toBe('Alex (roommate)');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/split-participants/${id}`,
    });
    expect(del.statusCode).toBe(204);
  });

  it('rejects duplicate participant names per tenant', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/split-participants',
      payload: { name: 'Bob' },
      headers: { 'content-type': 'application/json' },
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/split-participants',
      payload: { name: 'Bob' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(409);
  });

  it('PUT shares replaces all shares; GET reports your remaining share', async () => {
    const accountId = await seedAccount();
    const txnId = await seedTxn(accountId, -10000, 'Dinner');

    const a = await app.inject({
      method: 'POST',
      url: '/api/split-participants',
      payload: { name: 'Alex' },
      headers: { 'content-type': 'application/json' },
    });
    const b = await app.inject({
      method: 'POST',
      url: '/api/split-participants',
      payload: { name: 'Bo' },
      headers: { 'content-type': 'application/json' },
    });

    const put = await app.inject({
      method: 'PUT',
      url: `/api/transactions/${txnId}/shares`,
      payload: {
        shares: [
          { participantId: a.json().participant.id, shareCents: -2500 },
          { participantId: b.json().participant.id, shareCents: -2500 },
        ],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ok: true, written: 2 });

    const get = await app.inject({
      method: 'GET',
      url: `/api/transactions/${txnId}/shares`,
    });
    expect(get.json()).toMatchObject({
      transactionAmountCents: -10000,
      sharesTotalCents: -5000,
      yourShareCents: -5000,
    });
    expect(get.json().shares).toHaveLength(2);
  });

  it('PUT shares rejects sign mismatch and over-allocation', async () => {
    const accountId = await seedAccount();
    const txnId = await seedTxn(accountId, -10000);
    const a = await app.inject({
      method: 'POST',
      url: '/api/split-participants',
      payload: { name: 'A' },
      headers: { 'content-type': 'application/json' },
    });

    // Sign mismatch: positive share on negative txn.
    const sign = await app.inject({
      method: 'PUT',
      url: `/api/transactions/${txnId}/shares`,
      payload: {
        shares: [{ participantId: a.json().participant.id, shareCents: 5000 }],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(sign.statusCode).toBe(400);

    // Over-allocation: total exceeds the transaction magnitude.
    const over = await app.inject({
      method: 'PUT',
      url: `/api/transactions/${txnId}/shares`,
      payload: {
        shares: [{ participantId: a.json().participant.id, shareCents: -15000 }],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(over.statusCode).toBe(400);
  });

  it('settle toggles share state', async () => {
    const accountId = await seedAccount();
    const txnId = await seedTxn(accountId, -10000);
    const a = await app.inject({
      method: 'POST',
      url: '/api/split-participants',
      payload: { name: 'A' },
      headers: { 'content-type': 'application/json' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/transactions/${txnId}/shares`,
      payload: {
        shares: [{ participantId: a.json().participant.id, shareCents: -5000 }],
      },
      headers: { 'content-type': 'application/json' },
    });
    const shares = await pool.query<{ id: string }>(
      `SELECT id FROM transaction_shares WHERE transaction_id = $1`,
      [txnId],
    );
    const shareId = shares.rows[0]!.id;

    const settled = await app.inject({
      method: 'POST',
      url: `/api/transaction-shares/${shareId}/settle`,
      payload: { settled: true },
      headers: { 'content-type': 'application/json' },
    });
    expect(settled.json().share.settled).toBe(true);

    const reopened = await app.inject({
      method: 'POST',
      url: `/api/transaction-shares/${shareId}/settle`,
      payload: { settled: false },
      headers: { 'content-type': 'application/json' },
    });
    expect(reopened.json().share.settled).toBe(false);
  });

  it('summary aggregates open shares per participant', async () => {
    const accountId = await seedAccount();
    const txn1 = await seedTxn(accountId, -10000, 'Dinner');
    const txn2 = await seedTxn(accountId, -4000, 'Lunch');

    const a = await app.inject({
      method: 'POST',
      url: '/api/split-participants',
      payload: { name: 'Alex' },
      headers: { 'content-type': 'application/json' },
    });
    const aid = a.json().participant.id;

    await app.inject({
      method: 'PUT',
      url: `/api/transactions/${txn1}/shares`,
      payload: { shares: [{ participantId: aid, shareCents: -5000 }] },
      headers: { 'content-type': 'application/json' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/transactions/${txn2}/shares`,
      payload: { shares: [{ participantId: aid, shareCents: -2000 }] },
      headers: { 'content-type': 'application/json' },
    });

    const sum = await app.inject({
      method: 'GET',
      url: '/api/shares/summary',
    });
    const row = (sum.json().summary as Array<{
      participant_id: string;
      net_open_cents: string | number;
    }>).find((r) => r.participant_id === aid)!;
    expect(Number(row.net_open_cents)).toBe(-7000);
  });

  it('assistant tool split_transaction auto-creates participants by name', async () => {
    const accountId = await seedAccount();
    const txnId = await seedTxn(accountId, -10000);
    const { findTool } = await import('../../src/domain/assistant/tools.js');
    const tid = (await pool.query<{ id: string }>(`SELECT id FROM tenants LIMIT 1`)).rows[0]!.id;
    const r = (await findTool('split_transaction')!.execute(
      { tenantId: tid, userId: '11111111-1111-1111-1111-111111111111' },
      {
        transactionId: txnId,
        shares: [
          { participantName: 'Cam', shareCents: -3000 },
          { participantName: 'Dee', shareCents: -3000 },
        ],
      },
    )) as { ok: boolean; sharesWritten: number };
    expect(r).toMatchObject({ ok: true, sharesWritten: 2 });

    const participants = await pool.query(
      `SELECT name FROM split_participants WHERE tenant_id = $1 ORDER BY name`,
      [tid],
    );
    expect(participants.rows.map((r) => (r as { name: string }).name)).toEqual([
      'Cam',
      'Dee',
    ]);
    const audit = await pool.query(
      `SELECT details FROM audit_log WHERE action = 'assistant.split_transaction'`,
    );
    expect(audit.rowCount).toBe(1);
  });
});
