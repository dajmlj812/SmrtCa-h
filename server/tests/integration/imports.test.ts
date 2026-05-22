import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb, seedAccount } from '../setup/test-db.js';
import { fixtureBuffer } from '../setup/fixtures.js';
import { buildForm } from '../setup/multipart.js';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

describe('Imports API', () => {
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

  it('lists the built-in import formats', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/imports/formats',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().formats.length).toBeGreaterThanOrEqual(2);
  });

  it('previews a Chase credit-card file without saving it', async () => {
    const form = buildForm({
      name: 'cc.csv',
      buffer: fixtureBuffer('chase-credit-card.csv'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/preview',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const { preview } = res.json();
    expect(preview.detectedFormatId).toBe('chase_credit_card');
    expect(preview.totalRows).toBe(8);
    expect(preview.parsedCount).toBe(8);
    expect(preview.errorCount).toBe(0);
    expect(preview.sample.length).toBeGreaterThan(0);
  });

  it('reports an unrecognized file format', async () => {
    const form = buildForm({
      name: 'mystery.csv',
      buffer: fixtureBuffer('unknown-format.csv'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/preview',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().preview.detectedFormatId).toBeNull();
  });

  it('commits an import into an account', async () => {
    const accountId = await seedAccount();
    const form = buildForm(
      { name: 'bank.csv', buffer: fixtureBuffer('chase-bank.csv') },
      { accountId },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.importedCount).toBe(5);
  });

  it('skips duplicates when the same file is committed twice', async () => {
    const accountId = await seedAccount();
    const first = buildForm(
      { name: 'bank.csv', buffer: fixtureBuffer('chase-bank.csv') },
      { accountId },
    );
    await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: first,
      headers: first.getHeaders(),
    });
    const second = buildForm(
      { name: 'bank.csv', buffer: fixtureBuffer('chase-bank.csv') },
      { accountId },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: second,
      headers: second.getHeaders(),
    });
    expect(res.json().result.importedCount).toBe(0);
    expect(res.json().result.skippedCount).toBe(5);
  });

  it('rejects a commit with no accountId', async () => {
    const form = buildForm({
      name: 'bank.csv',
      buffer: fixtureBuffer('chase-bank.csv'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a commit with no file', async () => {
    const form = buildForm(null, { accountId: ZERO_UUID });
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('records an import batch', async () => {
    const accountId = await seedAccount();
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
      method: 'GET',
      url: `/api/imports?accountId=${accountId}`,
    });
    expect(res.json().batches).toHaveLength(1);
    expect(res.json().batches[0].imported_count).toBe(8);
  });
});
