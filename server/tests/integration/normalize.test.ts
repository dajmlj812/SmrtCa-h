import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb, seedAccount } from '../setup/test-db.js';
import { fixtureBuffer } from '../setup/fixtures.js';
import { buildForm } from '../setup/multipart.js';

describe('Normalize API', () => {
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

  it('reports the configured AI provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().provider).toBe('string');
  });

  it('normalizes pending transactions after an import', async () => {
    const accountId = await seedAccount({ type: 'credit_card' });
    const form = buildForm(
      { name: 'cc.csv', buffer: fixtureBuffer('chase-credit-card.csv') },
      { accountId },
    );
    await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/normalize',
      payload: { accountId },
    });
    expect(res.statusCode).toBe(200);
    const { summary } = res.json();
    expect(summary.processed).toBe(8);
    expect(summary.normalized).toBe(8);
    expect(summary.errors).toBe(0);
  });

  it('rejects an invalid accountId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/normalize',
      payload: { accountId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
  });
});
