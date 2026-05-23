import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { pool, query, withTransaction } from '../db/pool.js';
import {
  PasswordPolicyError,
  hashPassword,
  validatePassword,
} from '../auth/passwords.js';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  pruneExpiredSessions,
} from '../auth/sessions.js';
import {
  clearProviderCache,
  getProvider,
  listProviders,
} from '../auth/providers/registry.js';
import { resolveIdentity } from '../auth/identities.js';
import { recordAudit } from '../domain/audit.js';

const OIDC_STATE_COOKIE = 'smrtcash_oidc_state';

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

async function activeTenantForUser(userId: string): Promise<string | null> {
  // Pick the user's first membership (by created_at). Used when minting
  // a brand-new session.
  const r = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM memberships
      WHERE user_id = $1
      ORDER BY created_at LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.tenant_id ?? null;
}

async function isInstanceSetup(): Promise<boolean> {
  const r = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM users`,
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public — what the login page needs to render.
  app.get('/api/auth/status', async (req) => {
    const setup = await isInstanceSetup();
    return {
      isSetup: setup,
      authenticated: req.user !== undefined,
    };
  });

  // Lists enabled providers (Local always; OIDC/SAML depending on
  // auth_provider_configs). Public.
  app.get('/api/auth/providers', async () => {
    const providers = await listProviders();
    return {
      providers: providers.map((p) => ({
        id: p.id,
        kind: p.kind,
        displayName: p.displayName,
        enabled: p.enabled,
      })),
    };
  });

  // First-boot bootstrap: creates the first user as owner of the
  // already-seeded Default tenant. Refuses once any user exists.
  app.post('/api/auth/setup', async (req, reply) => {
    if (await isInstanceSetup()) {
      return reply.code(409).send({ error: 'Already initialized' });
    }
    const body = (req.body ?? {}) as {
      email?: unknown;
      name?: unknown;
      password?: unknown;
    };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (email === '') {
      return reply.code(400).send({ error: 'Email is required' });
    }
    try {
      validatePassword(body.password);
    } catch (err) {
      if (err instanceof PasswordPolicyError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    const hash = await hashPassword(body.password as string);

    // Phase 9: first user on a fresh install is a super_admin. They
    // are NOT a tenant member — managing tenants is their job; they'll
    // create tenants + invite tenant admins from /system. Existing
    // upgrades keep their tenant_admin role unchanged via the
    // migration.
    const result = await withTransaction(async (client) => {
      const u = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO users (email, name, password_hash, is_super_admin)
         VALUES ($1, $2, $3, true)
         RETURNING id, created_at`,
        [email, name || 'Operator', hash],
      );
      const userId = u.rows[0]!.id;
      await client.query(
        `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
         VALUES ($1, 'local', $2, $3)`,
        [userId, userId, email],
      );
      return { userId, createdAt: u.rows[0]!.created_at };
    });

    const session = await createSession(result.userId, null);
    setSessionCookie(reply, session.id, session.expiresAt);
    await recordAudit({
      actorUserId: result.userId,
      actorKind: 'super_admin',
      action: 'super_admin.bootstrap',
      details: { email },
    });
    return reply.code(201).send({
      user: {
        id: result.userId,
        email,
        name,
        created_at: result.createdAt,
        is_super_admin: true,
      },
    });
  });

  // Local password login. The frontend sends { email, password }. The
  // legacy single-user form (password only) is still accepted for the
  // first migration cycle — it picks the singleton user when there's
  // exactly one.
  app.post('/api/auth/login', async (req, reply) => {
    if (!(await isInstanceSetup())) {
      return reply.code(409).send({ error: 'Not initialized' });
    }
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const local = await getProvider('local');
    if (!local || !local.verify) {
      return reply.code(500).send({ error: 'Local provider unavailable' });
    }

    // Back-compat: if no email is supplied and there's exactly one user,
    // act on that user. Drop in a future cleanup once everyone has migrated.
    let email = typeof body.email === 'string' ? body.email.trim() : '';
    if (email === '') {
      const sole = await pool.query<{ email: string | null; n: number }>(
        `SELECT email, COUNT(*) OVER ()::int AS n FROM users LIMIT 1`,
      );
      if (sole.rowCount === 1 && sole.rows[0]!.n === 1 && sole.rows[0]!.email) {
        email = sole.rows[0]!.email;
      }
    }
    if (email === '') {
      return reply.code(400).send({ error: 'Email is required' });
    }

    let identity;
    try {
      identity = await local.verify({ email, password: body.password });
    } catch (err) {
      return reply
        .code(401)
        .send({ error: err instanceof Error ? err.message : 'Login failed' });
    }
    const resolved = await resolveIdentity(identity);
    // Super admins have no memberships by design — that's fine; they
    // land on /system. Tenant users need at least one membership.
    const userRow = await pool.query<{ is_super_admin: boolean }>(
      `SELECT is_super_admin FROM users WHERE id = $1`,
      [resolved.userId],
    );
    const isSuperAdmin = userRow.rows[0]?.is_super_admin ?? false;
    let tenantId: string | null = null;
    if (!isSuperAdmin) {
      tenantId = await activeTenantForUser(resolved.userId);
      if (!tenantId) {
        return reply.code(403).send({
          error: 'No tenant membership for this user',
        });
      }
    }
    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [
      resolved.userId,
    ]);
    void pruneExpiredSessions().catch((err) =>
      req.log.warn({ err }, 'Session cleanup failed'),
    );
    const session = await createSession(resolved.userId, tenantId);
    setSessionCookie(reply, session.id, session.expiresAt);
    void recordAudit({
      tenantId,
      actorUserId: resolved.userId,
      actorKind: isSuperAdmin ? 'super_admin' : 'tenant_user',
      action: isSuperAdmin ? 'super_admin.login' : 'user.login',
    });
    return {
      user: {
        id: resolved.userId,
        email: resolved.email,
        name: resolved.name,
        is_super_admin: isSuperAdmin,
      },
    };
  });

  // ── OIDC: begin + callback ───────────────────────────────
  app.get<{ Params: { slug: string }; Querystring: { returnTo?: string } }>(
    '/api/auth/oidc/:slug/begin',
    async (req, reply) => {
      const provider = await getProvider(`oidc:${req.params.slug}`);
      if (!provider) {
        return reply.code(404).send({ error: 'Unknown provider' });
      }
      const result = await provider.begin({ returnTo: req.query.returnTo });
      if (result.kind !== 'redirect') {
        return reply.code(500).send({ error: 'Provider did not start a redirect flow' });
      }
      // Stash the per-attempt state in a short-lived signed cookie so
      // the callback can verify it. Cookie name includes the slug so
      // simultaneous attempts to different IdPs don't trample each other.
      reply.setCookie(
        `${OIDC_STATE_COOKIE}_${req.params.slug}`,
        JSON.stringify(result.state),
        {
          httpOnly: true,
          sameSite: 'lax', // 'lax' so the cookie survives the IdP redirect
          secure: config.auth.cookieSecure,
          path: '/',
          signed: true,
          maxAge: 600, // 10 minutes
        },
      );
      return reply.redirect(result.url);
    },
  );

  app.get<{
    Params: { slug: string };
    Querystring: Record<string, string>;
  }>('/api/auth/oidc/:slug/callback', async (req, reply) => {
    const provider = await getProvider(`oidc:${req.params.slug}`);
    if (!provider || !provider.completeRedirect) {
      return reply.code(404).send({ error: 'Unknown provider' });
    }
    const cookieName = `${OIDC_STATE_COOKIE}_${req.params.slug}`;
    const rawCookie = req.cookies[cookieName];
    if (!rawCookie) {
      return reply.code(400).send({ error: 'OIDC state cookie missing — expired or third-party blocked' });
    }
    const unsigned = req.unsignCookie(rawCookie);
    if (!unsigned.valid || !unsigned.value) {
      return reply.code(400).send({ error: 'OIDC state cookie invalid' });
    }
    reply.clearCookie(cookieName, { path: '/' });

    let state: Record<string, string>;
    try {
      state = JSON.parse(unsigned.value) as Record<string, string>;
    } catch {
      return reply.code(400).send({ error: 'OIDC state cookie unparseable' });
    }

    let identity;
    try {
      identity = await provider.completeRedirect(req.query, state);
    } catch (err) {
      return reply.code(401).send({
        error: err instanceof Error ? err.message : 'OIDC callback failed',
      });
    }
    const resolved = await resolveIdentity(identity);
    const tenantId = await activeTenantForUser(resolved.userId);
    if (!tenantId) {
      return reply.code(403).send({
        error:
          "This account isn't a member of any tenant. Ask an admin for an invitation.",
      });
    }
    const session = await createSession(resolved.userId, tenantId);
    setSessionCookie(reply, session.id, session.expiresAt);

    // Return the user to where they came from (sanitized).
    const returnTo =
      typeof state.returnTo === 'string' && state.returnTo.startsWith('/')
        ? state.returnTo
        : '/';
    return reply.redirect(returnTo);
  });

  // Settings UI hook: rebuild the registry after a config change.
  app.post('/api/auth/providers/reload', async () => {
    clearProviderCache();
    return { ok: true };
  });

  // Logout — idempotent.
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
    const u = await query<{
      id: string;
      email: string | null;
      name: string | null;
      created_at: string;
      last_login_at: string | null;
      is_super_admin: boolean;
    }>(
      `SELECT id, email, name, created_at::text, last_login_at::text,
              is_super_admin
         FROM users WHERE id = $1`,
      [req.user.id],
    );
    if (u.rowCount === 0) {
      return reply.code(401).send({ error: 'User not found' });
    }
    const memberships = await query<{
      tenant_id: string;
      tenant_name: string;
      tenant_slug: string;
      role: string;
    }>(
      `SELECT m.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, m.role
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1
        ORDER BY m.created_at`,
      [req.user.id],
    );
    return {
      user: u.rows[0],
      memberships: memberships.rows,
      active_tenant_id: req.user.tenantId ?? null,
    };
  });
}

// Helper used by membership / invite routes to mint a fresh random token.
export function randomToken(): string {
  return randomBytes(24).toString('base64url');
}
