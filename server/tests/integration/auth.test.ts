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
      expect(res.json()).toEqual({
        isSetup: false,
        authenticated: false,
        signupEnabled: false,
      });
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
      expect(status.json()).toEqual({
        isSetup: true,
        authenticated: true,
        signupEnabled: false,
      });
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

  // ── 0.16.0: public signup + email verification ────────────────

  describe('public signup (0.16.0)', () => {
    // Save / restore the env var so other suites in the file aren't
    // affected by us enabling signup mid-run.
    let originalGate: string | undefined;
    beforeAll(() => {
      originalGate = process.env.PUBLIC_SIGNUP_ENABLED;
    });
    afterAll(() => {
      if (originalGate === undefined) delete process.env.PUBLIC_SIGNUP_ENABLED;
      else process.env.PUBLIC_SIGNUP_ENABLED = originalGate;
    });
    beforeEach(async () => {
      await resetDb({ skipAuth: true });
      // Need at least one user for /api/auth/setup to be considered
      // "done"; resetDb doesn't always seed one. The "no setup user"
      // path is exercised by the first-boot suite above.
      await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { email: 'op@local', password: 'correct-horse-battery-staple' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
    });

    it('returns 404 on /api/auth/signup when the gate is off', async () => {
      delete process.env.PUBLIC_SIGNUP_ENABLED;
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: {
          email: 'new@example.com',
          password: 'correct-horse-battery-staple',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(r.statusCode).toBe(404);
    });

    it('signup creates an unverified user + issues a token', async () => {
      process.env.PUBLIC_SIGNUP_ENABLED = 'true';
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: {
          email: 'alice@example.com',
          name: 'Alice',
          password: 'correct-horse-battery-staple',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(r.statusCode).toBe(202);
      expect(r.json()).toEqual({ status: 'verification_sent' });

      const user = await pool.query<{ id: string; email_verified_at: string | null }>(
        `SELECT id, email_verified_at::text AS email_verified_at FROM users WHERE email = 'alice@example.com'`,
      );
      expect(user.rowCount).toBe(1);
      expect(user.rows[0]!.email_verified_at).toBeNull();

      const tok = await pool.query<{ token: string }>(
        `SELECT token FROM email_verifications WHERE user_id = $1 AND consumed_at IS NULL`,
        [user.rows[0]!.id],
      );
      expect(tok.rowCount).toBe(1);
      expect(tok.rows[0]!.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    });

    it('signup is idempotent for a verified existing email (returns 202; no new token)', async () => {
      process.env.PUBLIC_SIGNUP_ENABLED = 'true';
      // First signup + verify.
      await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: { email: 'bob@example.com', password: 'correct-horse-battery-staple' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      const tok1 = await pool.query<{ token: string }>(
        `SELECT token FROM email_verifications WHERE user_id =
           (SELECT id FROM users WHERE email = 'bob@example.com')`,
      );
      await app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        payload: { token: tok1.rows[0]!.token },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);

      // Second signup with same email — must still return 202
      // (no enumeration leak) but NOT mint a fresh token.
      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: { email: 'bob@example.com', password: 'whatever-it-doesnt-matter' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(second.statusCode).toBe(202);
      const tok2 = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM email_verifications WHERE user_id =
           (SELECT id FROM users WHERE email = 'bob@example.com')`,
      );
      expect(Number(tok2.rows[0]!.n)).toBe(1);
    });

    it('verify-email consumes the token, provisions a tenant, and signs the user in', async () => {
      process.env.PUBLIC_SIGNUP_ENABLED = 'true';
      await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: { email: 'carol@example.com', name: 'Carol', password: 'correct-horse-battery-staple' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      const tok = await pool.query<{ token: string }>(
        `SELECT token FROM email_verifications WHERE user_id =
           (SELECT id FROM users WHERE email = 'carol@example.com')`,
      );
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        payload: { token: tok.rows[0]!.token },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(r.statusCode).toBe(200);
      const cookie = r.headers['set-cookie'];
      const cookieHeader = Array.isArray(cookie) ? cookie.join('; ') : (cookie ?? '');
      expect(cookieHeader).toContain('smrtcash_session=');

      const body = r.json();
      expect(body.user.email).toBe('carol@example.com');
      expect(body.tenantId).toMatch(/^[0-9a-f-]{36}$/);

      // Tenant + membership exist.
      const memb = await pool.query<{ role: string }>(
        `SELECT role FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE u.email = 'carol@example.com'`,
      );
      expect(memb.rowCount).toBe(1);
      expect(memb.rows[0]!.role).toBe('admin');

      // Token is consumed; replay must fail.
      const replay = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        payload: { token: tok.rows[0]!.token },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toMatch(/already been used/i);
    });

    it('verify-email rejects an expired token', async () => {
      process.env.PUBLIC_SIGNUP_ENABLED = 'true';
      await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: { email: 'dave@example.com', password: 'correct-horse-battery-staple' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      // Backdate the token's expiry.
      await pool.query(
        `UPDATE email_verifications
            SET expires_at = now() - interval '1 hour'
          WHERE user_id = (SELECT id FROM users WHERE email = 'dave@example.com')`,
      );
      const tok = await pool.query<{ token: string }>(
        `SELECT token FROM email_verifications WHERE user_id =
           (SELECT id FROM users WHERE email = 'dave@example.com')`,
      );
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        payload: { token: tok.rows[0]!.token },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/expired/i);
    });

    it('login refuses an unverified user with a clear message', async () => {
      process.env.PUBLIC_SIGNUP_ENABLED = 'true';
      await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: { email: 'eve@example.com', password: 'correct-horse-battery-staple' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'eve@example.com', password: 'correct-horse-battery-staple' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toMatch(/confirm your email/i);
    });

    it('status reports signupEnabled when the env flag is set', async () => {
      process.env.PUBLIC_SIGNUP_ENABLED = 'true';
      const r = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        skipAuth: true,
      } as any);
      expect(r.json().signupEnabled).toBe(true);
    });
  });
});
