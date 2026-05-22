import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb } from '../setup/test-db.js';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

describe('Accounts API', () => {
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

  it('creates an account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        name: 'My Checking',
        type: 'checking',
        institution: 'Test Bank',
        last4: '1234',
      },
    });
    expect(res.statusCode).toBe(201);
    const { account } = res.json();
    expect(account.id).toBeDefined();
    expect(account.name).toBe('My Checking');
    expect(account.type).toBe('checking');
  });

  it('rejects an account with no name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { type: 'checking' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid account type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Bad', type: 'crypto-wallet' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists accounts with computed balance and transaction count', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Savings', type: 'savings' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(res.statusCode).toBe(200);
    const { accounts } = res.json();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].balance_cents).toBe(0);
    expect(accounts[0].transaction_count).toBe(0);
  });

  it('fetches a single account by id', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Solo', type: 'cash' },
      })
    ).json();
    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${created.account.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.name).toBe('Solo');
  });

  it('returns 404 for a missing account', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${ZERO_UUID}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for a malformed account id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts/not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
  });

  it('deletes an account', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Temp', type: 'other' },
      })
    ).json();
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${created.account.id}`,
    });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: `/api/accounts/${created.account.id}`,
    });
    expect(after.statusCode).toBe(404);
  });

  it('returns 404 when deleting a missing account', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${ZERO_UUID}`,
    });
    expect(res.statusCode).toBe(404);
  });
});
