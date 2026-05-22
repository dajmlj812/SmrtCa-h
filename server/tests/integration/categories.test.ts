import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb } from '../setup/test-db.js';
import { DEFAULT_CATEGORIES } from '../../src/domain/categories.js';

describe('Categories API', () => {
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

  it('lists the seeded default categories', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/categories' });
    expect(res.statusCode).toBe(200);
    const { categories } = res.json();
    expect(categories.length).toBe(DEFAULT_CATEGORIES.length);
    expect(categories.map((c: { name: string }) => c.name)).toContain(
      'Uncategorized',
    );
    expect(categories.every((c: { transaction_count: number }) => c.transaction_count === 0)).toBe(true);
  });

  it('creates a new category', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Pet Care' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().category.name).toBe('Pet Care');
  });

  it('rejects a duplicate category name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Income' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects an empty name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('renames a category', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name: 'Pet Care' },
      })
    ).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${created.category.id}`,
      payload: { name: 'Pets & Animals' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().category.name).toBe('Pets & Animals');
  });

  it('deletes a category', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name: 'Pet Care' },
      })
    ).json();
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/categories/${created.category.id}`,
    });
    expect(del.statusCode).toBe(204);
  });
});
