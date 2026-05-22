import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb } from '../setup/test-db.js';
import { fixtureBuffer } from '../setup/fixtures.js';
import { buildForm } from '../setup/multipart.js';

/**
 * Smoke tests — a fast check that the major features work. Run this right
 * after a build or deploy to decide whether deeper testing is worthwhile.
 */
describe('Smoke', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await makeTestApp();
    await resetDb();
  });
  afterAll(async () => {
    await app.close();
  });

  it('the health endpoint responds OK', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('critical path: create an account, import a file, view transactions', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Smoke Test Account', type: 'credit_card' },
    });
    expect(created.statusCode).toBe(201);
    const accountId = created.json().account.id;

    const form = buildForm(
      { name: 'cc.csv', buffer: fixtureBuffer('chase-credit-card.csv') },
      { accountId },
    );
    const imported = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().result.importedCount).toBe(8);

    const transactions = await app.inject({
      method: 'GET',
      url: `/api/transactions?accountId=${accountId}`,
    });
    expect(transactions.statusCode).toBe(200);
    expect(transactions.json().total).toBe(8);
  });
});
