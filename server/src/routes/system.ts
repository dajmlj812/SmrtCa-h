import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { pool, query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { listAudit, recordAudit } from '../domain/audit.js';
import { hashPassword, validatePassword, PasswordPolicyError } from '../auth/passwords.js';
import { requireSuperAdmin } from '../auth/rbac.js';
import { getStripe, isStripeConfigured } from '../billing/stripe.js';
import { handleSubscriptionUpsert } from '../billing/webhook-handlers.js';
import { PLAN_FEATURES, type Plan } from '../auth/entitlements.js';
import { rotateTenantKey } from '../attachments/tenant-keys.js';

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

  // ── 0.16.1: super-admin subscriptions console ──────────────
  //
  //   GET    /api/system/subscriptions             — list all tenants with sub state
  //   POST   /api/system/subscriptions/:tenantId/grant — courtesy grant
  //   POST   /api/system/subscriptions/:tenantId/sync  — re-pull from Stripe
  //   DELETE /api/system/subscriptions/:tenantId       — local force-cancel
  //
  // The runbook's "courtesy access" and "reconciling a state
  // mismatch" sections previously sent the operator to a CLI
  // script; these routes back the same flows from the UI. Every
  // mutation audits.

  app.get('/api/system/subscriptions', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    // LEFT JOIN tenants → subscriptions so tenants without a row
    // appear with everything null (state = "no subscription").
    // Sort: newest tenants first; gives the operator a fresh-signup
    // view at the top.
    const r = await query<{
      tenant_id: string;
      tenant_name: string;
      tenant_slug: string;
      tenant_created_at: string;
      member_count: number;
      plan_id: string | null;
      status: string | null;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      trial_end: string | null;
      current_period_end: string | null;
      cancel_at_period_end: boolean | null;
      sub_updated_at: string | null;
    }>(
      `SELECT t.id AS tenant_id,
              t.name AS tenant_name,
              t.slug AS tenant_slug,
              t.created_at::text AS tenant_created_at,
              COALESCE(m.member_count, 0)::int AS member_count,
              s.plan_id,
              s.status,
              s.stripe_customer_id,
              s.stripe_subscription_id,
              s.trial_end::text AS trial_end,
              s.current_period_end::text AS current_period_end,
              s.cancel_at_period_end,
              s.updated_at::text AS sub_updated_at
         FROM tenants t
    LEFT JOIN subscriptions s ON s.tenant_id = t.id
    LEFT JOIN (SELECT tenant_id, COUNT(*) AS member_count FROM memberships GROUP BY tenant_id) m
           ON m.tenant_id = t.id
     ORDER BY t.created_at DESC`,
    );
    return { rows: r.rows };
  });

  app.post<{ Params: { tenantId: string } }>(
    '/api/system/subscriptions/:tenantId/grant',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.tenantId)) {
        return reply.code(400).send({ error: 'Invalid tenant id' });
      }
      const body = (req.body ?? {}) as {
        plan?: unknown;
        days?: unknown;
        reason?: unknown;
      };
      const plan = typeof body.plan === 'string' ? (body.plan as Plan) : '';
      if (!(plan in PLAN_FEATURES)) {
        return reply.code(400).send({ error: 'plan must be starter, plus, or family' });
      }
      const days = Number(body.days);
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        return reply.code(400).send({ error: 'days must be between 1 and 365' });
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

      // Ensure the tenant exists.
      const t = await pool.query<{ id: string }>(
        `SELECT id FROM tenants WHERE id = $1`,
        [req.params.tenantId],
      );
      if (t.rowCount === 0) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      const periodEnd = new Date(Date.now() + days * 86400_000);
      await pool.query(
        // UPSERT — overrides any prior plan/status. Stripe IDs are
        // intentionally left untouched: if the tenant later goes
        // through Checkout the webhook will fill them in.
        `INSERT INTO subscriptions
           (tenant_id, plan_id, status, current_period_end, cancel_at_period_end)
         VALUES ($1, $2, 'active', $3, false)
         ON CONFLICT (tenant_id) DO UPDATE SET
           plan_id = EXCLUDED.plan_id,
           status = EXCLUDED.status,
           current_period_end = EXCLUDED.current_period_end,
           cancel_at_period_end = false,
           updated_at = now()`,
        [req.params.tenantId, plan, periodEnd],
      );

      await recordAudit({
        tenantId: req.params.tenantId,
        actorUserId: req.user!.id,
        actorKind: 'super_admin',
        action: 'subscription.grant',
        targetKind: 'subscription',
        targetId: req.params.tenantId,
        details: { plan, days, reason: reason || null },
      });
      return reply.send({ granted: true, plan, current_period_end: periodEnd.toISOString() });
    },
  );

  app.post<{ Params: { tenantId: string } }>(
    '/api/system/subscriptions/:tenantId/sync',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.tenantId)) {
        return reply.code(400).send({ error: 'Invalid tenant id' });
      }
      if (!isStripeConfigured()) {
        return reply.code(503).send({ error: 'Billing is not configured' });
      }
      // Need a stripe_subscription_id to pull from; courtesy-granted
      // rows have none.
      const row = await pool.query<{ stripe_subscription_id: string | null }>(
        `SELECT stripe_subscription_id FROM subscriptions WHERE tenant_id = $1`,
        [req.params.tenantId],
      );
      const stripeSubId = row.rows[0]?.stripe_subscription_id ?? null;
      if (!stripeSubId) {
        return reply.code(404).send({
          error: 'No Stripe subscription id on file for this tenant — nothing to sync',
        });
      }

      let sub: Stripe.Subscription;
      try {
        sub = await getStripe().subscriptions.retrieve(stripeSubId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        req.log.error({ err, tenantId: req.params.tenantId }, 'Stripe sync failed');
        return reply.code(502).send({ error: `Stripe lookup failed: ${msg}` });
      }
      // Re-use the webhook-handler's UPSERT logic so a sync produces
      // exactly the same row as a real customer.subscription.updated
      // event would.
      const fakeEvent = {
        type: 'customer.subscription.updated' as Stripe.Event.Type,
        data: { object: sub } as Stripe.Event.Data,
      } as Stripe.Event;
      const result = await handleSubscriptionUpsert(fakeEvent);
      await recordAudit({
        tenantId: req.params.tenantId,
        actorUserId: req.user!.id,
        actorKind: 'super_admin',
        action: 'subscription.sync',
        targetKind: 'subscription',
        targetId: req.params.tenantId,
        details: { applied: result.applied, reason: result.reason ?? null },
      });
      if (!result.applied) {
        return reply.code(409).send({
          error: result.reason ?? 'Sync rejected (missing metadata?)',
        });
      }
      return reply.send({ synced: true });
    },
  );

  app.delete<{ Params: { tenantId: string } }>(
    '/api/system/subscriptions/:tenantId',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.tenantId)) {
        return reply.code(400).send({ error: 'Invalid tenant id' });
      }
      // Local force-cancel: clears the subscriptions row entirely.
      // We do NOT touch Stripe — that's the operator's job via the
      // Stripe dashboard, by design (the runbook explains why
      // hand-editing rows is dangerous when Stripe still considers
      // the subscription live). This action is meant for tenants
      // who have no Stripe sub (courtesy-granted, dev/test rows) or
      // for cleanup after the Stripe side has already been canceled.
      const result = await pool.query(
        `DELETE FROM subscriptions WHERE tenant_id = $1`,
        [req.params.tenantId],
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'No subscription on this tenant' });
      }
      await recordAudit({
        tenantId: req.params.tenantId,
        actorUserId: req.user!.id,
        actorKind: 'super_admin',
        action: 'subscription.force_cancel',
        targetKind: 'subscription',
        targetId: req.params.tenantId,
      });
      return reply.send({ cleared: true });
    },
  );

  // ── 0.16.4: rotate per-tenant attachment encryption key ────
  //
  // Mints a fresh DEK for the tenant, re-encrypts every existing
  // attachment under it, then commits the new wrapped DEK +
  // bumps the generation. Synchronous — small tenants finish in
  // milliseconds; tenants with many large attachments can take
  // a while. We don't background-job this in 0.16.4 because the
  // operator triggers it manually and the request timeout
  // (default 60s) is generous; if a tenant outgrows that, we'll
  // promote this to a background job later.
  app.post<{ Params: { id: string } }>(
    '/api/system/tenants/:id/rotate-encryption-key',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid tenant id' });
      }
      const exists = await pool.query<{ id: string }>(
        `SELECT id FROM tenants WHERE id = $1`,
        [req.params.id],
      );
      if (exists.rowCount === 0) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }
      try {
        const result = await rotateTenantKey(req.params.id);
        await recordAudit({
          tenantId: req.params.id,
          actorUserId: req.user!.id,
          actorKind: 'super_admin',
          action: 'tenant.rotate_encryption_key',
          targetKind: 'tenant',
          targetId: req.params.id,
          details: {
            attachments_rewritten: result.attachments_rewritten,
            new_generation: result.new_generation,
          },
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        req.log.error({ err, tenantId: req.params.id }, 'Encryption rotation failed');
        // Bubble the message so the operator sees why (most
        // common cause: ATTACHMENT_ENCRYPTION_KEY not set).
        return reply.code(500).send({ error: `Rotation failed: ${msg}` });
      }
    },
  );

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
