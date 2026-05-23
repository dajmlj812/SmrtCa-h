import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, pool, resetDb, seedAccount } from '../setup/test-db.js';

describe('Bills + recurring income + cash-flow', () => {
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

  it('creates a bill, lists it, marks paid (advances next_due_date)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'Electric',
        amountCents: 12500,
        frequency: 'monthly',
        nextDueDate: '2026-05-15',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().bill.id;

    const paid = await app.inject({
      method: 'POST',
      url: `/api/bills/${id}/mark-paid`,
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().bill.next_due_date).toBe('2026-06-15');
  });

  it('one-time bills deactivate after mark-paid', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'Annual fee',
        amountCents: 9500,
        frequency: 'one-time',
        nextDueDate: '2026-05-15',
      },
      headers: { 'content-type': 'application/json' },
    });
    const id = create.json().bill.id;
    const paid = await app.inject({
      method: 'POST',
      url: `/api/bills/${id}/mark-paid`,
    });
    expect(paid.json().bill.active).toBe(false);
  });

  it('rejects unknown frequency', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'X',
        amountCents: 100,
        frequency: 'fortnightly',
        nextDueDate: '2026-05-15',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('upcoming bills honors the days window', async () => {
    // Future bill within window.
    const today = new Date();
    const inFifteen = new Date(today);
    inFifteen.setUTCDate(inFifteen.getUTCDate() + 15);
    const inSixty = new Date(today);
    inSixty.setUTCDate(inSixty.getUTCDate() + 60);

    await app.inject({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'Soon',
        amountCents: 100,
        frequency: 'monthly',
        nextDueDate: inFifteen.toISOString().slice(0, 10),
      },
      headers: { 'content-type': 'application/json' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'Later',
        amountCents: 100,
        frequency: 'monthly',
        nextDueDate: inSixty.toISOString().slice(0, 10),
      },
      headers: { 'content-type': 'application/json' },
    });

    const r = await app.inject({
      method: 'GET',
      url: '/api/bills/upcoming?days=30',
    });
    expect(r.json().bills).toHaveLength(1);
    expect(r.json().bills[0]!.name).toBe('Soon');
  });

  it('creates a recurring income entry and lists it', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/recurring-income',
      payload: {
        name: 'Salary',
        amountCents: 500000,
        frequency: 'biweekly',
        nextExpectedDate: '2026-05-30',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: '/api/recurring-income',
    });
    expect(list.json().income).toHaveLength(1);
  });

  describe('cash-flow projection', () => {
    it('walks the starting balance forward through bill + income events', async () => {
      // Seed an account opening balance of $1,000.
      await app.inject({
        method: 'PATCH',
        url: `/api/accounts/${accountId}`,
        payload: { opening_balance_cents: 100000 },
        headers: { 'content-type': 'application/json' },
      });

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const inFive = new Date(today);
      inFive.setUTCDate(inFive.getUTCDate() + 5);
      const inTen = new Date(today);
      inTen.setUTCDate(inTen.getUTCDate() + 10);

      // -$200 bill in 5 days.
      await app.inject({
        method: 'POST',
        url: '/api/bills',
        payload: {
          name: 'Internet',
          amountCents: 20000,
          frequency: 'monthly',
          nextDueDate: inFive.toISOString().slice(0, 10),
        },
        headers: { 'content-type': 'application/json' },
      });
      // +$500 income in 10 days.
      await app.inject({
        method: 'POST',
        url: '/api/recurring-income',
        payload: {
          name: 'Side gig',
          amountCents: 50000,
          frequency: 'monthly',
          nextExpectedDate: inTen.toISOString().slice(0, 10),
        },
        headers: { 'content-type': 'application/json' },
      });

      const r = await app.inject({
        method: 'GET',
        url: '/api/cash-flow?days=15',
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.starting_cents).toBe(100000);
      expect(body.series).toHaveLength(16); // day 0 .. day 15
      expect(body.series[0]!.projected_cents).toBe(100000);
      // After 5 days (post-bill).
      expect(body.series[5]!.projected_cents).toBe(80000);
      // After 10 days (post-income).
      expect(body.series[10]!.projected_cents).toBe(130000);
      // Ending balance.
      expect(body.ending_cents).toBe(130000);
    });

    it('inactive bills are ignored', async () => {
      const today = new Date();
      const inFive = new Date(today);
      inFive.setUTCDate(inFive.getUTCDate() + 5);
      const create = await app.inject({
        method: 'POST',
        url: '/api/bills',
        payload: {
          name: 'Ignored',
          amountCents: 99999,
          frequency: 'monthly',
          nextDueDate: inFive.toISOString().slice(0, 10),
        },
        headers: { 'content-type': 'application/json' },
      });
      await pool.query(`UPDATE bills SET active = false WHERE id = $1`, [
        create.json().bill.id,
      ]);
      const r = await app.inject({
        method: 'GET',
        url: '/api/cash-flow?days=10',
      });
      expect(r.json().ending_cents).toBe(r.json().starting_cents);
    });
  });
});
