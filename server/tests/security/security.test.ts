import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb, seedAccount, pool } from '../setup/test-db.js';
import { fixtureBuffer } from '../setup/fixtures.js';
import { buildForm } from '../setup/multipart.js';

/**
 * Security tests — try to break the app with hostile or malformed input.
 * A good suite proves the app degrades gracefully instead of crashing or
 * leaking/destroying data.
 */
describe('Security & abuse', () => {
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

  it('treats SQL in the search parameter as a literal string', async () => {
    const accountId = await seedAccount();
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-05-01', -100, 'NORMAL PURCHASE', $2)`,
      [accountId, randomUUID()],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/transactions?search=${encodeURIComponent("' OR '1'='1")}`,
    });
    expect(res.statusCode).toBe(200);
    // The injection string matches nothing; it is not executed.
    expect(res.json().total).toBe(0);

    // The transactions table is still intact.
    const still = await pool.query('SELECT COUNT(*)::int AS c FROM transactions');
    expect(still.rows[0]!.c).toBe(1);
  });

  it('stores SQL-injection attempts in an account name as literal text', async () => {
    const hostileName = "Robert'); DROP TABLE accounts;--";
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: hostileName, type: 'checking' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().account.name).toBe(hostileName);

    // The accounts table survived; the list endpoint still works.
    const list = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(list.statusCode).toBe(200);
    expect(list.json().accounts).toHaveLength(1);
  });

  it('does not crash on wrong-typed request body fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 12345, type: ['not', 'a', 'string'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(500);
  });

  it('rejects an injection attempt in a path parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${encodeURIComponent("' OR 1=1 --")}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not crash on an oversized account name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'A'.repeat(50_000), type: 'cash' },
    });
    expect(res.statusCode).not.toBe(500);
  });

  it('handles non-CSV content gracefully instead of erroring', async () => {
    const garbage = Buffer.from(
      'this is not a real csv file\njust some random text\n',
    );
    const form = buildForm({ name: 'fake.csv', buffer: garbage });
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/preview',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().preview.detectedFormatId).toBeNull();
  });

  it('rejects an import commit with no file', async () => {
    const form = buildForm(null, { accountId: randomUUID() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('strips path components from an uploaded filename', async () => {
    const accountId = await seedAccount();
    const form = buildForm(
      {
        name: '../../../etc/passwd.csv',
        buffer: fixtureBuffer('chase-credit-card.csv'),
      },
      { accountId },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    // The upload layer sanitizes the filename — no path traversal survives.
    const batch = await pool.query<{ filename: string }>(
      'SELECT filename FROM import_batches WHERE account_id = $1',
      [accountId],
    );
    expect(batch.rows[0]!.filename).not.toContain('..');
    expect(batch.rows[0]!.filename).not.toContain('/');
  });

  it('returns 404 for an unknown route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/this-route-does-not-exist',
    });
    expect(res.statusCode).toBe(404);
  });
});
