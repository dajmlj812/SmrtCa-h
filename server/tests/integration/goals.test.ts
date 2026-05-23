import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb } from '../setup/test-db.js';

describe('Savings goals API', () => {
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

  it('creates, lists, updates, and deletes a goal', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/goals',
      payload: {
        name: 'Emergency fund',
        targetAmountCents: 1000000,
        currentAmountCents: 250000,
        targetDate: '2026-12-31',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(create.statusCode).toBe(201);
    expect(Number(create.json().goal.progress)).toBeCloseTo(0.25);

    const list = await app.inject({ method: 'GET', url: '/api/goals' });
    expect(list.json().goals).toHaveLength(1);

    const id = create.json().goal.id;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/goals/${id}`,
      payload: { currentAmountCents: 500000 },
      headers: { 'content-type': 'application/json' },
    });
    expect(Number(patch.json().goal.progress)).toBeCloseTo(0.5);

    const del = await app.inject({ method: 'DELETE', url: `/api/goals/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it('caps progress at 1.0 even when current exceeds target', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/goals',
      payload: {
        name: 'Overshot',
        targetAmountCents: 100000,
        currentAmountCents: 150000,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(Number(r.json().goal.progress)).toBe(1);
  });

  it('rejects a non-positive target', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/goals',
      payload: { name: 'Bad', targetAmountCents: 0 },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects a malformed target date', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/goals',
      payload: {
        name: 'Bad',
        targetAmountCents: 1000,
        targetDate: 'tomorrow',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('returns 404 patching a missing goal', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/goals/00000000-0000-0000-0000-000000000000',
      payload: { currentAmountCents: 1000 },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
  });
});
