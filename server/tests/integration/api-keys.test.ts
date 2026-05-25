import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, pool, resetDb, seedAccount } from '../setup/test-db.js';

describe('Public-API keys (0.18.4)', () => {
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

  it('mints a key, lists it (prefix only), and the token authenticates a GET', async () => {
    // Mint via the session-authed cookie.
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/api-keys',
      payload: { label: 'home dashboard' },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.startsWith('smrt_')).toBe(true);
    expect(body.key.label).toBe('home dashboard');
    expect(body.key.key_prefix.startsWith('smrt_')).toBe(true);
    const token = body.token as string;

    // List — token must NOT come back.
    const list = await app.inject({ method: 'GET', url: '/api/me/api-keys' });
    expect(list.statusCode).toBe(200);
    const keys = list.json().keys as Array<{ key_prefix: string; label: string }>;
    expect(keys.length).toBe(1);
    expect(keys[0]!.label).toBe('home dashboard');
    expect((keys[0] as Record<string, unknown>).key_hash).toBeUndefined();

    // Use the token (no cookie) — read endpoint succeeds.
    await seedAccount({ name: 'For Bearer test' });
    const accounts = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${token}` },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(accounts.statusCode).toBe(200);
    expect(Array.isArray(accounts.json().accounts)).toBe(true);
  });

  it('rejects mutating requests (POST/PATCH/DELETE) made with an API key', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/api-keys',
      payload: { label: 'read-only-test' },
    });
    const token = created.json().token as string;

    const post = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: { name: 'Should be blocked', institution: 'x', type: 'checking' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(post.statusCode).toBe(403);
    expect(post.json().error).toMatch(/read-only/i);
  });

  it('401s a bogus or missing Bearer token', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: 'Bearer smrt_not-a-real-token-just-a-string-here-yo' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(bad.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(missing.statusCode).toBe(401);
  });

  it('revoked keys stop authenticating', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/api-keys',
      payload: { label: 'short-lived' },
    });
    const token = created.json().token as string;
    const id = created.json().key.id as string;

    // Works before revoke.
    const ok = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${token}` },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(ok.statusCode).toBe(200);

    // Revoke (cookie-authed).
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/me/api-keys/${id}`,
    });
    expect(del.statusCode).toBe(200);

    // Same token now 401s.
    const after = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${token}` },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(after.statusCode).toBe(401);
  });

  it('API-key-authed requests see only the bound tenant\'s data', async () => {
    // Set up tenant B with its own account.
    const tA = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
    );
    const tenantAId = tA.rows[0]!.id;
    const tB = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Other', 'other-${Date.now()}') RETURNING id`,
    );
    const tenantBId = tB.rows[0]!.id;

    const accA = await seedAccount({ name: 'Tenant A account', tenantId: tenantAId });
    const accB = await seedAccount({ name: 'Tenant B account', tenantId: tenantBId });

    // Mint a key in tenant A (the default active tenant for the
    // seeded test session).
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/api-keys',
      payload: { label: 'tenant-A only' },
    });
    const token = created.json().token as string;

    const accounts = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${token}` },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(accounts.statusCode).toBe(200);
    const ids = (accounts.json().accounts as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(accA);
    expect(ids).not.toContain(accB);
  });

  it('caps active keys per user at 10', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/me/api-keys',
        payload: { label: `key-${i}` },
      });
      expect(r.statusCode).toBe(200);
    }
    const overflow = await app.inject({
      method: 'POST',
      url: '/api/me/api-keys',
      payload: { label: 'one-too-many' },
    });
    expect(overflow.statusCode).toBe(400);
    expect(overflow.json().error).toMatch(/Maximum/i);
  });
});
