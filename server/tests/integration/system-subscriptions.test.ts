import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeSuperAdminCookie,
  makeTestApp,
  pool,
  resetDb,
} from '../setup/test-db.js';

/**
 * 0.16.1 — super-admin subscriptions console.
 *
 * Coverage:
 *   - super-admin gate on every route (tenant admin gets 403)
 *   - list returns one row per tenant, with null subscription
 *     fields for tenants with no sub
 *   - grant courtesy plan UPSERTs the row + records an audit entry
 *   - force-cancel deletes the row + audits
 *   - sync 503s when Stripe is not configured (signal-only —
 *     hitting Stripe needs a live key)
 */

function asSuper(cookie: string) {
  return { headers: { cookie }, skipAuth: true };
}

async function seedTenant(name: string, slug: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return r.rows[0]!.id;
}

describe('Super-admin subscriptions console (0.16.1)', () => {
  let app: FastifyInstance;
  let superCookie: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    superCookie = await makeSuperAdminCookie(app);
  });

  // ── Gate ──────────────────────────────────────────────────

  it('tenant admin gets 403 on /api/system/subscriptions', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/system/subscriptions' });
    expect(r.statusCode).toBe(403);
  });

  it('tenant admin gets 403 on grant / sync / delete', async () => {
    const tenantId = await seedTenant('Test', 'test-t');
    const grant = await app.inject({
      method: 'POST',
      url: `/api/system/subscriptions/${tenantId}/grant`,
      payload: { plan: 'plus', days: 30 },
      headers: { 'content-type': 'application/json' },
    });
    expect(grant.statusCode).toBe(403);

    const sync = await app.inject({
      method: 'POST',
      url: `/api/system/subscriptions/${tenantId}/sync`,
    });
    expect(sync.statusCode).toBe(403);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/system/subscriptions/${tenantId}`,
    });
    expect(del.statusCode).toBe(403);
  });

  // ── List ──────────────────────────────────────────────────

  it('list returns every tenant; subscription fields null when none', async () => {
    await seedTenant('Has none', 'has-none');
    const r = await app.inject({
      method: 'GET',
      url: '/api/system/subscriptions',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Array.isArray(body.rows)).toBe(true);
    // resetDb seeds Default with a Family active subscription.
    const noPlan = body.rows.find((x: { tenant_slug: string }) => x.tenant_slug === 'has-none');
    expect(noPlan).toBeDefined();
    expect(noPlan.plan_id).toBeNull();
    expect(noPlan.status).toBeNull();
    expect(noPlan.stripe_customer_id).toBeNull();
    const seeded = body.rows.find((x: { tenant_slug: string }) => x.tenant_slug === 'default');
    expect(seeded).toBeDefined();
    expect(seeded.plan_id).toBe('family');
    expect(seeded.status).toBe('active');
  });

  // ── Grant ─────────────────────────────────────────────────

  it('grant validates plan and days', async () => {
    const tenantId = await seedTenant('GrantValidate', 'grant-validate');

    const badPlan = await app.inject({
      method: 'POST',
      url: `/api/system/subscriptions/${tenantId}/grant`,
      payload: { plan: 'enterprise', days: 30 },
      headers: { 'content-type': 'application/json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(badPlan.statusCode).toBe(400);

    const badDays = await app.inject({
      method: 'POST',
      url: `/api/system/subscriptions/${tenantId}/grant`,
      payload: { plan: 'plus', days: 99999 },
      headers: { 'content-type': 'application/json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(badDays.statusCode).toBe(400);
  });

  it('grant UPSERTs the subscription row and records audit', async () => {
    const tenantId = await seedTenant('GrantTarget', 'grant-target');
    const r = await app.inject({
      method: 'POST',
      url: `/api/system/subscriptions/${tenantId}/grant`,
      payload: { plan: 'plus', days: 30, reason: 'apology' },
      headers: { 'content-type': 'application/json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().granted).toBe(true);

    const sub = await pool.query<{
      plan_id: string;
      status: string;
      current_period_end: string;
    }>(
      `SELECT plan_id, status, current_period_end::text FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(sub.rowCount).toBe(1);
    expect(sub.rows[0]!.plan_id).toBe('plus');
    expect(sub.rows[0]!.status).toBe('active');
    // ~30 days from now (within 60s of grant).
    const periodEndMs = new Date(sub.rows[0]!.current_period_end).getTime();
    const expectMs = Date.now() + 30 * 86400_000;
    expect(Math.abs(periodEndMs - expectMs)).toBeLessThan(60_000);

    const audit = await pool.query<{ action: string; details: { plan: string; days: number; reason: string | null } }>(
      `SELECT action, details FROM audit_log
        WHERE target_kind = 'subscription' AND target_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId],
    );
    expect(audit.rows[0]!.action).toBe('subscription.grant');
    expect(audit.rows[0]!.details.plan).toBe('plus');
    expect(audit.rows[0]!.details.reason).toBe('apology');
  });

  it('second grant overwrites the prior row', async () => {
    const tenantId = await seedTenant('Overwrite', 'overwrite');
    await app.inject({
      method: 'POST',
      url: `/api/system/subscriptions/${tenantId}/grant`,
      payload: { plan: 'plus', days: 30 },
      headers: { 'content-type': 'application/json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    await app.inject({
      method: 'POST',
      url: `/api/system/subscriptions/${tenantId}/grant`,
      payload: { plan: 'family', days: 60 },
      headers: { 'content-type': 'application/json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    const r = await pool.query<{ plan_id: string; n: string }>(
      `SELECT plan_id, COUNT(*) OVER ()::text AS n FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(Number(r.rows[0]!.n)).toBe(1);
    expect(r.rows[0]!.plan_id).toBe('family');
  });

  it('grant 404s for an unknown tenant', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/system/subscriptions/00000000-0000-0000-0000-000000000000/grant`,
      payload: { plan: 'plus', days: 30 },
      headers: { 'content-type': 'application/json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(404);
  });

  // ── Force-cancel ──────────────────────────────────────────

  it('force-cancel deletes the row and audits', async () => {
    const tenantId = await seedTenant('Cancel', 'cancel-me');
    await app.inject({
      method: 'POST',
      url: `/api/system/subscriptions/${tenantId}/grant`,
      payload: { plan: 'plus', days: 30 },
      headers: { 'content-type': 'application/json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/system/subscriptions/${tenantId}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(200);
    const remaining = await pool.query(
      `SELECT 1 FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(remaining.rowCount).toBe(0);
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId],
    );
    expect(audit.rows[0]!.action).toBe('subscription.force_cancel');
  });

  it('force-cancel 404s when no subscription exists', async () => {
    const tenantId = await seedTenant('NoSubHere', 'no-sub-here');
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/system/subscriptions/${tenantId}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(404);
  });

  // ── Sync ──────────────────────────────────────────────────

  it('sync 503s when Stripe is not configured', async () => {
    const tenantId = await seedTenant('SyncTest', 'sync-test');
    // Give the tenant a stripe_subscription_id so the "no Stripe id"
    // 404 path doesn't short-circuit.
    await pool.query(
      `INSERT INTO subscriptions (tenant_id, plan_id, status, stripe_subscription_id)
       VALUES ($1, 'plus', 'active', 'sub_test_fake')`,
      [tenantId],
    );
    const had = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const r = await app.inject({
        method: 'POST',
        url: `/api/system/subscriptions/${tenantId}/sync`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(asSuper(superCookie) as any),
      });
      expect(r.statusCode).toBe(503);
    } finally {
      if (had !== undefined) process.env.STRIPE_SECRET_KEY = had;
    }
  });

  it('sync 404s when the tenant has no stripe_subscription_id', async () => {
    const tenantId = await seedTenant('NoStripe', 'no-stripe');
    // Need Stripe "configured" to get past the 503 gate, but the
    // route never actually calls Stripe in this branch.
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_routing_only';
    const r = await app.inject({
      method: 'POST',
      url: `/api/system/subscriptions/${tenantId}/sync`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatch(/no Stripe subscription id/i);
  });
});
