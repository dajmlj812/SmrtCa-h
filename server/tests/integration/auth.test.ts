import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, pool, resetDb } from '../setup/test-db.js';

describe('Auth API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  describe('first-boot setup', () => {
    beforeEach(async () => {
      await resetDb({ skipAuth: true });
    });

    it('status reports isSetup=false when no user exists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ isSetup: false, authenticated: false });
    });

    it('setup creates the user, returns a session cookie, and is then logged in', async () => {
      const setup = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { email: 'owner@local', password: 'correct-horse-battery-staple' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(setup.statusCode).toBe(201);
      expect(setup.json().user.id).toBeDefined();
      const cookie = setup.headers['set-cookie'];
      expect(cookie).toBeDefined();
      const cookieHeader = Array.isArray(cookie) ? cookie.join('; ') : cookie!;
      expect(cookieHeader).toContain('smrtcash_session=');
      expect(cookieHeader).toContain('HttpOnly');
      expect(cookieHeader).toContain('SameSite=Strict');

      // The same cookie now authenticates further requests.
      const status = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        headers: { cookie: cookieHeader },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(status.json()).toEqual({ isSetup: true, authenticated: true });
    });

    it('rejects setup with a short password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { email: 'owner@local', password: 'short' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/at least/i);
    });

    it('refuses a second setup once initialized', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { email: 'owner@local', password: 'correct-horse-battery-staple' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { email: 'owner@local', password: 'another-good-password' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(second.statusCode).toBe(409);
    });

    it('login returns 409 before setup', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'owner@local', password: 'whatever' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/not initialized/i);
    });
  });

  describe('login + logout (real argon2 hash)', () => {
    let cookie: string;

    beforeEach(async () => {
      await resetDb({ skipAuth: true });
      // Set up with a known password, then we'll test logging in with it.
      const setup = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { email: 'owner@local', password: 'correct-horse-battery-staple' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      const raw = setup.headers['set-cookie'];
      cookie = Array.isArray(raw) ? raw.join('; ') : raw!;
    });

    it('login with the right password issues a fresh cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'owner@local', password: 'correct-horse-battery-staple' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(res.statusCode).toBe(200);
      expect(res.headers['set-cookie']).toBeDefined();
      // last_login_at is now populated.
      const r = await pool.query<{ last_login_at: string | null }>(
        'SELECT last_login_at FROM users LIMIT 1',
      );
      expect(r.rows[0]!.last_login_at).not.toBeNull();
    });

    it('login with the wrong password returns 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'owner@local', password: 'wrong' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(res.statusCode).toBe(401);
    });

    it('logout clears the session row and the cookie', async () => {
      const before = await pool.query('SELECT COUNT(*) FROM sessions');
      expect(Number(before.rows[0]!.count)).toBeGreaterThan(0);

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(res.statusCode).toBe(204);
      const after = await pool.query('SELECT COUNT(*) FROM sessions');
      expect(Number(after.rows[0]!.count)).toBe(0);
    });

    it('GET /api/auth/me returns the authenticated user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(res.statusCode).toBe(200);
      expect(res.json().user.id).toBeDefined();
    });
  });

  describe('auth gate on private routes', () => {
    beforeEach(async () => {
      await resetDb({ skipAuth: true });
    });

    it('returns 401 on a private route without a cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/accounts',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with a tampered cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/accounts',
        headers: { cookie: 'smrtcash_session=bogus.signature' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(res.statusCode).toBe(401);
    });

    it('lets /api/health through without a cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/health',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(res.statusCode).toBe(200);
    });
  });
});
