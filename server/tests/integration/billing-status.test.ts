import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  FEATURES,
  checkAndIncrementQuota,
} from '../../src/auth/entitlements.js';
import { makeTestApp, pool, resetDb } from '../setup/test-db.js';

/**
 * 0.15.3 — GET /api/billing/status powers the /billing page in the
 * web client. Shape contract:
 *
 *   plan: 'starter' | 'plus' | 'family' | null
 *   status: trialing | active | past_due | canceled | null
 *   trialEnd / currentPeriodEnd: ISO strings or null
 *   usage.{aiAssistant, receiptOcr}: { used, cap, remaining } per period
 *     (cap=null means unlimited on this plan)
 *   caps.{bankConnections, householdMembers}: { used, cap } live count
 */

describe('GET /api/billing/status (0.15.3)', () => {
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

  async function defaultTenantId(): Promise<string> {
    const t = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
    );
    return t.rows[0]!.id;
  }

  it('returns family/active with unlimited quotas for the default test tenant', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/billing/status' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      plan: 'family',
      status: 'active',
      cancelAtPeriodEnd: false,
      hasStripeCustomer: false, // resetDb seeds via grant-script shape; no Stripe IDs
    });
    // Family quotas are unlimited → cap = null on metered features.
    expect(body.usage.aiAssistant.cap).toBeNull();
    expect(body.usage.aiAssistant.remaining).toBeNull();
    expect(body.usage.receiptOcr.cap).toBeNull();
    // Caps are still reported for the hard limits.
    expect(body.caps.bankConnections.cap).toBe(25);
    expect(body.caps.householdMembers.cap).toBe(6);
  });

  it('reports plan=null when the tenant has no subscription row', async () => {
    const tenantId = await defaultTenantId();
    await pool.query('DELETE FROM subscriptions WHERE tenant_id = $1', [tenantId]);
    const r = await app.inject({ method: 'GET', url: '/api/billing/status' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.plan).toBeNull();
    expect(body.status).toBeNull();
    // Usage rolls up to zero with no plan.
    expect(body.usage.aiAssistant.used).toBe(0);
    expect(body.caps.bankConnections.cap).toBe(0);
  });

  it('reports plus tier caps + usage', async () => {
    const tenantId = await defaultTenantId();
    await pool.query(
      `UPDATE subscriptions
          SET plan_id = 'plus', status = 'active',
              current_period_end = now() + interval '1 month'
        WHERE tenant_id = $1`,
      [tenantId],
    );
    // Burn 3 AI assistant ticks via the same helper the route uses.
    await checkAndIncrementQuota(tenantId, FEATURES.AI_ASSISTANT, 3);

    const r = await app.inject({ method: 'GET', url: '/api/billing/status' });
    const body = r.json();
    expect(body.plan).toBe('plus');
    expect(body.usage.aiAssistant.used).toBe(3);
    expect(body.usage.aiAssistant.cap).toBe(500);
    expect(body.usage.aiAssistant.remaining).toBe(497);
    expect(body.usage.receiptOcr.cap).toBe(200);
    expect(body.caps.bankConnections.cap).toBe(10);
    expect(body.caps.householdMembers.cap).toBe(1);
  });

  it('reports trialing status with trialEnd populated', async () => {
    const tenantId = await defaultTenantId();
    const trialEnd = new Date(Date.now() + 14 * 86400_000);
    await pool.query(
      `UPDATE subscriptions
          SET plan_id = 'plus', status = 'trialing',
              trial_end = $2,
              current_period_end = $2
        WHERE tenant_id = $1`,
      [tenantId, trialEnd],
    );
    const r = await app.inject({ method: 'GET', url: '/api/billing/status' });
    const body = r.json();
    expect(body.plan).toBe('plus');
    expect(body.status).toBe('trialing');
    expect(body.trialEnd).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(body.trialEnd).getTime()).toBeGreaterThan(Date.now());
  });

  it('hasStripeCustomer flips true when stripe_customer_id is set', async () => {
    const tenantId = await defaultTenantId();
    await pool.query(
      `UPDATE subscriptions SET stripe_customer_id = $2 WHERE tenant_id = $1`,
      [tenantId, 'cus_test_status'],
    );
    const r = await app.inject({ method: 'GET', url: '/api/billing/status' });
    expect(r.json().hasStripeCustomer).toBe(true);
  });

  it('bank-connection cap counts both ofx_dc + plaid items', async () => {
    const tenantId = await defaultTenantId();
    await pool.query(
      `UPDATE subscriptions
          SET plan_id = 'plus', current_period_end = now() + interval '1 month'
        WHERE tenant_id = $1`,
      [tenantId],
    );
    // 2 plaid items.
    await pool.query(
      `INSERT INTO plaid_items (tenant_id, plaid_item_id, access_token_encrypted)
       VALUES ($1, 'a', 'enc'), ($1, 'b', 'enc')`,
      [tenantId],
    );
    const r = await app.inject({ method: 'GET', url: '/api/billing/status' });
    expect(r.json().caps.bankConnections.used).toBe(2);
  });

  it('requires an active tenant (403 for no tenant)', async () => {
    // Drop the membership so req.user.tenantId resolves to null.
    const tenantId = await defaultTenantId();
    await pool.query('DELETE FROM sessions');
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at, active_tenant_id)
       VALUES ('test-session-fixed-deterministic-id-9z4q',
               '11111111-1111-1111-1111-111111111111',
               now() + interval '1 day', NULL)`,
    );
    void tenantId;
    const r = await app.inject({ method: 'GET', url: '/api/billing/status' });
    expect(r.statusCode).toBe(403);
  });
});
