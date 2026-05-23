import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { isUuid } from '../util.js';
import {
  hashPassword,
  validatePassword,
  PasswordPolicyError,
} from '../auth/passwords.js';
import { createSession, setSessionTenant, SESSION_COOKIE } from '../auth/sessions.js';
import { config } from '../config.js';
import { renderInvitationEmail, tryMail } from '../domain/mailer.js';
import { getEffectiveValue } from '../domain/settings.js';

/**
 *   GET  /api/tenants                       — tenants the user belongs to
 *   POST /api/tenants/switch                — change active tenant on the session
 *
 *   GET  /api/tenants/:id/members           — list members (admin/owner only)
 *   POST /api/tenants/:id/invitations       — create an invite (admin/owner)
 *   GET  /api/tenants/:id/invitations       — list pending invites (admin/owner)
 *   DELETE /api/tenants/:id/invitations/:invId — revoke an invite
 *   DELETE /api/tenants/:id/members/:userId — remove a member (owner only)
 *
 *   GET  /api/invitations/:token            — fetch invite (public)
 *   POST /api/invitations/:token/accept     — accept invite (public; mints
 *                                              user if needed + session)
 *
 * Role enforcement here is intentionally light: owner/admin can manage
 * members; viewer/member can't. Per-row data access is governed by the
 * future RLS policies + tenant context on the session.
 */

const INVITE_TTL_DAYS = 14;

async function roleOf(
  userId: string,
  tenantId: string,
): Promise<string | null> {
  const r = await pool.query<{ role: string }>(
    `SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return r.rows[0]?.role ?? null;
}

function isAdmin(role: string | null): boolean {
  // Phase 9: 'admin' is the sole role that can manage members/invites.
  // Spouses and children cannot.
  return role === 'admin';
}

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  // ── Tenants the user belongs to ───────────────────────────
  app.get('/api/tenants', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
    const r = await query<{
      id: string;
      name: string;
      slug: string;
      role: string;
    }>(
      `SELECT t.id, t.name, t.slug, m.role
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1
        ORDER BY m.created_at`,
      [req.user.id],
    );
    return { tenants: r.rows, active_tenant_id: req.user.tenantId ?? null };
  });

  // ── Switch active tenant ──────────────────────────────────
  app.post('/api/tenants/switch', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
    const body = (req.body ?? {}) as { tenantId?: unknown };
    if (typeof body.tenantId !== 'string' || !isUuid(body.tenantId)) {
      return reply.code(400).send({ error: 'tenantId is required' });
    }
    const role = await roleOf(req.user.id, body.tenantId);
    if (!role) {
      return reply.code(403).send({ error: 'Not a member of that tenant' });
    }
    // Locate the session via cookie so we can update the row in place.
    const rawCookie = req.cookies[SESSION_COOKIE];
    if (rawCookie) {
      const unsigned = req.unsignCookie(rawCookie);
      if (unsigned.valid && unsigned.value) {
        await setSessionTenant(unsigned.value, body.tenantId);
      }
    }
    return { active_tenant_id: body.tenantId, role };
  });

  // ── Members ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/tenants/:id/members',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid tenant id' });
      const role = await roleOf(req.user.id, req.params.id);
      if (!role) return reply.code(403).send({ error: 'Forbidden' });
      const r = await query<{
        user_id: string;
        email: string | null;
        name: string | null;
        role: string;
        created_at: string;
        last_login_at: string | null;
      }>(
        `SELECT u.id AS user_id, u.email, u.name, m.role,
                m.created_at::text, u.last_login_at::text
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1
          ORDER BY m.created_at`,
        [req.params.id],
      );
      return { members: r.rows };
    },
  );

  // ── Child account assignments ─────────────────────────────
  app.get<{ Params: { id: string; userId: string } }>(
    '/api/tenants/:id/members/:userId/accounts',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
      if (!isUuid(req.params.id) || !isUuid(req.params.userId))
        return reply.code(400).send({ error: 'Invalid id' });
      const role = await roleOf(req.user.id, req.params.id);
      // Children may only inspect their own assignments; admins/spouses
      // inspect anyone's.
      const isOwnLookup = req.params.userId === req.user.id;
      if (!isAdmin(role) && role !== 'spouse' && !isOwnLookup) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      const r = await query<{ account_id: string; account_name: string }>(
        `SELECT a.id AS account_id, a.name AS account_name
           FROM account_user_access aua
           JOIN accounts a ON a.id = aua.account_id
          WHERE aua.tenant_id = $1 AND aua.user_id = $2`,
        [req.params.id, req.params.userId],
      );
      return { accounts: r.rows };
    },
  );

  app.put<{ Params: { id: string; userId: string } }>(
    '/api/tenants/:id/members/:userId/accounts',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
      if (!isUuid(req.params.id) || !isUuid(req.params.userId))
        return reply.code(400).send({ error: 'Invalid id' });
      const role = await roleOf(req.user.id, req.params.id);
      if (!isAdmin(role)) {
        return reply.code(403).send({ error: 'Only admins can assign accounts' });
      }
      const body = (req.body ?? {}) as { accountIds?: unknown };
      if (!Array.isArray(body.accountIds)) {
        return reply.code(400).send({ error: 'accountIds must be an array' });
      }
      const ids: string[] = [];
      for (const id of body.accountIds) {
        if (typeof id !== 'string' || !isUuid(id)) {
          return reply.code(400).send({ error: 'Invalid account id' });
        }
        ids.push(id);
      }
      await withTransaction(async (client) => {
        await client.query(
          `DELETE FROM account_user_access
            WHERE tenant_id = $1 AND user_id = $2`,
          [req.params.id, req.params.userId],
        );
        for (const aid of ids) {
          await client.query(
            `INSERT INTO account_user_access
               (account_id, user_id, tenant_id, created_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [aid, req.params.userId, req.params.id, req.user!.id],
          );
        }
      });
      return { ok: true, count: ids.length };
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/tenants/:id/members/:userId',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
      if (!isUuid(req.params.id) || !isUuid(req.params.userId))
        return reply.code(400).send({ error: 'Invalid id' });
      const role = await roleOf(req.user.id, req.params.id);
      if (role !== 'admin') {
        return reply.code(403).send({ error: 'Only admins can remove members' });
      }
      if (req.params.userId === req.user.id) {
        return reply.code(400).send({ error: 'Admins cannot remove themselves' });
      }
      await query(
        `DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
        [req.params.id, req.params.userId],
      );
      return reply.code(204).send();
    },
  );

  // ── Invitations ───────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/tenants/:id/invitations',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid tenant id' });
      const role = await roleOf(req.user.id, req.params.id);
      if (!isAdmin(role)) return reply.code(403).send({ error: 'Forbidden' });
      const r = await query<{
        id: string;
        email_hint: string | null;
        role: string;
        token: string;
        expires_at: string;
        accepted_at: string | null;
        created_at: string;
      }>(
        `SELECT id, email_hint, role, token,
                expires_at::text, accepted_at::text, created_at::text
           FROM invitations
          WHERE tenant_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [req.params.id],
      );
      return { invitations: r.rows };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/tenants/:id/invitations',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid tenant id' });
      const role = await roleOf(req.user.id, req.params.id);
      if (!isAdmin(role)) return reply.code(403).send({ error: 'Forbidden' });
      const body = (req.body ?? {}) as {
        emailHint?: unknown;
        role?: unknown;
      };
      const inviteRole =
        typeof body.role === 'string' &&
        ['admin', 'spouse', 'child'].includes(body.role)
          ? (body.role as 'admin' | 'spouse' | 'child')
          : 'spouse';
      const emailHint =
        typeof body.emailHint === 'string' ? body.emailHint.trim() || null : null;
      const token = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000);
      const r = await query<{
        id: string;
        token: string;
        expires_at: string;
      }>(
        `INSERT INTO invitations
           (tenant_id, email_hint, role, token, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, token, expires_at::text`,
        [req.params.id, emailHint, inviteRole, token, req.user.id, expiresAt],
      );

      // Best-effort email when SMTP is configured AND an email was
      // supplied. Failure to send is NOT fatal — the invite row still
      // exists and the copy-link UI works as a fallback.
      let emailResult: { sent: boolean; reason?: string } = {
        sent: false,
        reason: 'No email hint provided',
      };
      if (emailHint) {
        try {
          const tenantRes = await pool.query<{ name: string }>(
            `SELECT name FROM tenants WHERE id = $1`,
            [req.params.id],
          );
          const inviterRes = await pool.query<{
            name: string | null;
            email: string | null;
          }>(`SELECT name, email FROM users WHERE id = $1`, [req.user.id]);
          const baseUrl = await resolveBaseUrl(req.headers);
          const inviter =
            inviterRes.rows[0]?.name || inviterRes.rows[0]?.email || 'A teammate';
          const rendered = renderInvitationEmail({
            tenantName: tenantRes.rows[0]?.name ?? 'your workspace',
            inviterName: inviter,
            role: inviteRole,
            acceptUrl: `${baseUrl}/invite/${token}`,
            expiresAt: expiresAt.toISOString().slice(0, 10),
          });
          const sendRes = await tryMail({ to: emailHint, ...rendered });
          emailResult = { sent: sendRes.sent, reason: sendRes.reason };
        } catch (err) {
          emailResult = {
            sent: false,
            reason: err instanceof Error ? err.message : 'Send failed',
          };
        }
      }

      return reply.code(201).send({
        invitation: r.rows[0],
        email: emailResult,
      });
    },
  );

  app.delete<{ Params: { id: string; invId: string } }>(
    '/api/tenants/:id/invitations/:invId',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
      if (!isUuid(req.params.id) || !isUuid(req.params.invId))
        return reply.code(400).send({ error: 'Invalid id' });
      const role = await roleOf(req.user.id, req.params.id);
      if (!isAdmin(role)) return reply.code(403).send({ error: 'Forbidden' });
      await query(
        `DELETE FROM invitations WHERE id = $1 AND tenant_id = $2`,
        [req.params.invId, req.params.id],
      );
      return reply.code(204).send();
    },
  );

  // ── Public invite endpoints ───────────────────────────────
  app.get<{ Params: { token: string } }>(
    '/api/invitations/:token',
    async (req, reply) => {
      const r = await query<{
        id: string;
        tenant_id: string;
        tenant_name: string;
        email_hint: string | null;
        role: string;
        expires_at: string;
        accepted_at: string | null;
      }>(
        `SELECT i.id, i.tenant_id, t.name AS tenant_name, i.email_hint, i.role,
                i.expires_at::text, i.accepted_at::text
           FROM invitations i
           JOIN tenants t ON t.id = i.tenant_id
          WHERE i.token = $1
          LIMIT 1`,
        [req.params.token],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Invitation not found' });
      }
      const inv = r.rows[0]!;
      if (inv.accepted_at) {
        return reply.code(410).send({ error: 'Invitation already used' });
      }
      if (new Date(inv.expires_at).getTime() < Date.now()) {
        return reply.code(410).send({ error: 'Invitation expired' });
      }
      return { invitation: inv };
    },
  );

  app.post<{ Params: { token: string } }>(
    '/api/invitations/:token/accept',
    async (req, reply) => {
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

      const result = await withTransaction(async (client) => {
        const invRes = await client.query<{
          id: string;
          tenant_id: string;
          role: string;
          expires_at: string;
          accepted_at: string | null;
        }>(
          `SELECT id, tenant_id, role, expires_at::text, accepted_at::text
             FROM invitations WHERE token = $1 FOR UPDATE`,
          [req.params.token],
        );
        if (invRes.rowCount === 0) throw new Error('Invitation not found');
        const inv = invRes.rows[0]!;
        if (inv.accepted_at) throw new Error('Invitation already used');
        if (new Date(inv.expires_at).getTime() < Date.now()) {
          throw new Error('Invitation expired');
        }

        // Existing user with this email? Add a membership; else create.
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
          [email],
        );
        let userId: string;
        if (existing.rowCount && existing.rowCount > 0) {
          userId = existing.rows[0]!.id;
        } else {
          const hash = await hashPassword(body.password as string);
          const u = await client.query<{ id: string }>(
            `INSERT INTO users (email, name, password_hash)
             VALUES ($1, $2, $3) RETURNING id`,
            [email, name || email.split('@')[0], hash],
          );
          userId = u.rows[0]!.id;
          await client.query(
            `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
             VALUES ($1, 'local', $2, $3)`,
            [userId, userId, email],
          );
        }

        await client.query(
          `INSERT INTO memberships (tenant_id, user_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, user_id) DO NOTHING`,
          [inv.tenant_id, userId, inv.role],
        );
        await client.query(
          `UPDATE invitations
              SET accepted_at = now(), accepted_by = $1
            WHERE id = $2`,
          [userId, inv.id],
        );
        return { userId, tenantId: inv.tenant_id };
      });

      const session = await createSession(result.userId, result.tenantId);
      reply.setCookie(SESSION_COOKIE, session.id, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.auth.cookieSecure,
        path: '/',
        signed: true,
        expires: session.expiresAt,
      });
      return reply.code(201).send({
        user: { id: result.userId, email },
        tenant_id: result.tenantId,
      });
    },
  );
}

/**
 * Resolve the public base URL for outgoing links. Priority:
 *   1. APP_BASE_URL setting (operator-set; required for headless sends
 *      where the request that creates the invite has no real headers).
 *   2. The request's Origin / Host header (best-effort fallback when
 *      the create-invite call came from a browser session).
 */
async function resolveBaseUrl(headers: Record<string, unknown>): Promise<string> {
  const fromSettings = (await getEffectiveValue('APP_BASE_URL')).trim();
  if (fromSettings !== '') {
    return fromSettings.replace(/\/+$/, '');
  }
  const origin = headers['origin'];
  if (typeof origin === 'string' && origin.startsWith('http')) {
    return origin.replace(/\/+$/, '');
  }
  const proto = headers['x-forwarded-proto'] ?? 'http';
  const host = headers['host'];
  if (typeof host === 'string') {
    return `${String(proto)}://${host}`.replace(/\/+$/, '');
  }
  return 'http://localhost:4000';
}
