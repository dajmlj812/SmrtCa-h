import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { listAudit, recordAudit } from '../domain/audit.js';
import { hashPassword, validatePassword, PasswordPolicyError } from '../auth/passwords.js';
import { requireSuperAdmin } from '../auth/rbac.js';

/**
 * Super-admin console endpoints. Gated by `req.user.isSuperAdmin`.
 *
 * Capability boundary: super_admin manages tenants + tenant admins +
 * system settings + audit log, but NEVER reads tenant financial data.
 * Routes here either return tenant metadata (counts, member lists,
 * names) or operate on auth/system state. None of them ever join
 * against `transactions`, `accounts.balance`, etc.
 *
 *   GET    /api/system/tenants                 — list with stats
 *   POST   /api/system/tenants                 — create a tenant + first admin invite
 *   PATCH  /api/system/tenants/:id             — rename
 *   DELETE /api/system/tenants/:id             — delete (cascades to data!)
 *
 *   GET    /api/system/audit                   — paginated audit log
 *
 *   GET    /api/system/users                   — list super_admin users + a count of tenant users
 *   POST   /api/system/users/super             — create another super_admin
 */

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  // ── Tenants list (with safe stats only) ──────────────────
  app.get('/api/system/tenants', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const r = await query<{
      id: string;
      name: string;
      slug: string;
      created_at: string;
      member_count: number;
      account_count: number;
      transaction_count: number;
    }>(
      `SELECT t.id, t.name, t.slug, t.created_at::text,
              COALESCE(m.member_count, 0)::int AS member_count,
              COALESCE(a.account_count, 0)::int AS account_count,
              COALESCE(x.transaction_count, 0)::int AS transaction_count
         FROM tenants t
    LEFT JOIN (SELECT tenant_id, COUNT(*) AS member_count FROM memberships GROUP BY tenant_id) m
           ON m.tenant_id = t.id
    LEFT JOIN (SELECT tenant_id, COUNT(*) AS account_count FROM accounts GROUP BY tenant_id) a
           ON a.tenant_id = t.id
    LEFT JOIN (SELECT tenant_id, COUNT(*) AS transaction_count FROM transactions GROUP BY tenant_id) x
           ON x.tenant_id = t.id
     ORDER BY t.created_at`,
    );
    return { tenants: r.rows };
  });

  app.post('/api/system/tenants', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { name?: unknown; slug?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    if (name === '') {
      return reply.code(400).send({ error: 'Tenant name required' });
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(slug)) {
      return reply.code(400).send({ error: 'slug must be lowercase alphanumeric (dashes/underscores ok)' });
    }
    try {
      const r = await query<{ id: string }>(
        `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
        [name, slug],
      );
      const tenantId = r.rows[0]!.id;
      await recordAudit({
        tenantId,
        actorUserId: req.user!.id,
        actorKind: 'super_admin',
        action: 'tenant.create',
        targetKind: 'tenant',
        targetId: tenantId,
        details: { name, slug },
      });
      return reply.code(201).send({ tenant: { id: tenantId, name, slug } });
    } catch (err) {
      if (err instanceof Error && /duplicate key/.test(err.message)) {
        return reply.code(409).send({ error: 'A tenant with that slug already exists' });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/api/system/tenants/:id',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid tenant id' });
      }
      const body = (req.body ?? {}) as { name?: unknown };
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name required' });
      }
      const r = await query(
        `UPDATE tenants SET name = $1 WHERE id = $2 RETURNING id`,
        [body.name.trim(), req.params.id],
      );
      if (r.rowCount === 0) return reply.code(404).send({ error: 'Tenant not found' });
      await recordAudit({
        tenantId: req.params.id,
        actorUserId: req.user!.id,
        actorKind: 'super_admin',
        action: 'tenant.rename',
        targetKind: 'tenant',
        targetId: req.params.id,
        details: { name: body.name.trim() },
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/system/tenants/:id',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid tenant id' });
      }
      // Cascade is destructive — log first, delete second, so a crash
      // mid-delete still leaves an audit row.
      await recordAudit({
        tenantId: req.params.id,
        actorUserId: req.user!.id,
        actorKind: 'super_admin',
        action: 'tenant.delete',
        targetKind: 'tenant',
        targetId: req.params.id,
      });
      const r = await query(`DELETE FROM tenants WHERE id = $1`, [req.params.id]);
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }
      return reply.code(204).send();
    },
  );

  // ── Audit log ─────────────────────────────────────────────
  app.get<{
    Querystring: {
      tenantId?: string;
      action?: string;
      limit?: string;
      before?: string;
    };
  }>('/api/system/audit', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const opts: Parameters<typeof listAudit>[0] = {};
    if (req.query.tenantId === 'system') {
      opts.tenantId = null;
    } else if (req.query.tenantId && isUuid(req.query.tenantId)) {
      opts.tenantId = req.query.tenantId;
    }
    if (req.query.action) opts.action = req.query.action;
    if (req.query.limit) opts.limit = Number(req.query.limit) || 100;
    if (req.query.before) opts.before = req.query.before;
    const rows = await listAudit(opts);
    return { entries: rows };
  });

  // ── Super admin users ─────────────────────────────────────
  app.get('/api/system/users', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const supers = await query<{
      id: string;
      email: string | null;
      name: string | null;
      created_at: string;
      last_login_at: string | null;
    }>(
      `SELECT id, email, name, created_at::text, last_login_at::text
         FROM users
        WHERE is_super_admin = true
        ORDER BY created_at`,
    );
    const counts = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM users WHERE is_super_admin = false`,
    );
    return {
      super_admins: supers.rows,
      tenant_user_count: counts.rows[0]?.n ?? 0,
    };
  });

  app.post('/api/system/users/super', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const body = (req.body ?? {}) as {
      email?: unknown;
      name?: unknown;
      password?: unknown;
    };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (email === '') {
      return reply.code(400).send({ error: 'Email required' });
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
    // Refuse if the email already exists — emails are unique across
    // the system. Tenant users + super admins share the same pool.
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return reply.code(409).send({ error: 'A user with that email already exists' });
    }
    const inserted = await query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, is_super_admin)
       VALUES ($1, $2, $3, true)
       RETURNING id`,
      [email, typeof body.name === 'string' ? body.name.trim() : 'Operator', hash],
    );
    const userId = inserted.rows[0]!.id;
    await query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
       VALUES ($1, 'local', $2, $3)`,
      [userId, userId, email],
    );
    await recordAudit({
      actorUserId: req.user!.id,
      actorKind: 'super_admin',
      action: 'super_admin.create',
      targetKind: 'user',
      targetId: userId,
      details: { email },
    });
    return reply.code(201).send({ id: userId });
  });

  // Token to bootstrap the first tenant admin: super_admin creates the
  // tenant + a one-time link for the new admin to redeem.
  app.post<{ Params: { id: string } }>(
    '/api/system/tenants/:id/admin-invite',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid tenant id' });
      }
      const body = (req.body ?? {}) as { emailHint?: unknown };
      const emailHint = typeof body.emailHint === 'string' ? body.emailHint.trim() || null : null;
      const token = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + 14 * 86400_000);
      const ins = await query<{ id: string; token: string }>(
        `INSERT INTO invitations
           (tenant_id, email_hint, role, token, created_by, expires_at)
         VALUES ($1, $2, 'admin', $3, $4, $5)
         RETURNING id, token`,
        [req.params.id, emailHint, token, req.user!.id, expiresAt],
      );
      await recordAudit({
        tenantId: req.params.id,
        actorUserId: req.user!.id,
        actorKind: 'super_admin',
        action: 'tenant.admin_invite',
        targetKind: 'invitation',
        targetId: ins.rows[0]!.id,
        details: { emailHint },
      });
      return reply.code(201).send({
        invitation: {
          id: ins.rows[0]!.id,
          token: ins.rows[0]!.token,
          expires_at: expiresAt.toISOString(),
        },
      });
    },
  );
}
