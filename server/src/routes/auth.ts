import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import {
  PasswordPolicyError,
  hashPassword,
  validatePassword,
  verifyPassword,
} from '../auth/passwords.js';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  pruneExpiredSessions,
} from '../auth/sessions.js';

interface UserRow {
  id: string;
  password_hash: string;
  created_at: string;
  last_login_at: string | null;
}

async function loadSingletonUser(): Promise<UserRow | null> {
  const r = await query<UserRow>(
    `SELECT id, password_hash, created_at, last_login_at
       FROM users ORDER BY created_at LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.auth.cookieSecure,
    path: '/',
    signed: true,
    expires: expiresAt,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Tells the frontend whether the app is set up yet and whether the
  // current request is authenticated. Always safe to call.
  app.get('/api/auth/status', async (req) => {
    const user = await loadSingletonUser();
    return {
      isSetup: user !== null,
      authenticated: req.user !== undefined,
    };
  });

  // First-boot setup. Refuses once any user exists — there's only ever
  // one. After success the caller is also logged in.
  app.post('/api/auth/setup', async (req, reply) => {
    const existing = await loadSingletonUser();
    if (existing) {
      return reply.code(409).send({ error: 'Already initialized' });
    }
    const body = (req.body ?? {}) as { password?: unknown };
    try {
      validatePassword(body.password);
    } catch (err) {
      if (err instanceof PasswordPolicyError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    const hash = await hashPassword(body.password as string);
    const created = await query<{ id: string; created_at: string }>(
      `INSERT INTO users (password_hash) VALUES ($1)
       RETURNING id, created_at`,
      [hash],
    );
    const userId = created.rows[0]!.id;
    const session = await createSession(userId);
    setSessionCookie(reply, session.id, session.expiresAt);
    return reply.code(201).send({
      user: { id: userId, created_at: created.rows[0]!.created_at },
    });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const user = await loadSingletonUser();
    if (!user) {
      // Not set up — tell the client explicitly so it can route to setup.
      return reply.code(409).send({ error: 'Not initialized' });
    }
    const body = (req.body ?? {}) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (password === '' || !(await verifyPassword(user.password_hash, password))) {
      return reply.code(401).send({ error: 'Invalid password' });
    }
    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    // Opportunistic cleanup — runs at most once per login attempt.
    void pruneExpiredSessions().catch((err) =>
      req.log.warn({ err }, 'Session cleanup failed'),
    );
    const session = await createSession(user.id);
    setSessionCookie(reply, session.id, session.expiresAt);
    return { user: { id: user.id } };
  });

  // Logout is idempotent — deleting an unknown id is a no-op, and clearing
  // an unset cookie is a no-op. Always returns 204.
  app.post('/api/auth/logout', async (req, reply) => {
    const cookieValue = req.cookies[SESSION_COOKIE];
    if (cookieValue) {
      const unsigned = req.unsignCookie(cookieValue);
      if (unsigned.valid && unsigned.value) {
        await deleteSession(unsigned.value);
      }
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }
    const r = await query<{ id: string; created_at: string; last_login_at: string | null }>(
      `SELECT id, created_at, last_login_at FROM users WHERE id = $1`,
      [req.user.id],
    );
    if (r.rowCount === 0) {
      return reply.code(401).send({ error: 'User not found' });
    }
    return { user: r.rows[0] };
  });
}
