import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { resetDb } from '../setup/test-db.js';
import {
  FEATURES,
  checkAndIncrementQuota,
} from '../../src/auth/entitlements.js';

/**
 * 0.15.2 — route-level entitlement enforcement.
 *
 * Every premium route should:
 *   1. Return 402 (Payment Required) for a tenant on Starter (or no
 *      sub at all) when the feature isn't part of the plan.
 *   2. Pass through for a tenant on Family.
 *
 * We seed two tenants per test: A on Starter (or no sub), B on
 * Family. Then drive the actual HTTP routes via app.inject() against
 * both, asserting the 402-vs-2xx split.
 *
 * Conceptually similar to the cross-tenant-isolation suite but a
 * different axis — that one asks "can A see B's data?", this one
 * asks "can A even use this feature?"
 */

type Plan = 'starter' | 'plus' | 'family';

interface Harness {
  id: string;
  userId: string;
  cookie: string;
}

async function makeTenantWithPlan(
  app: FastifyInstance,
  name: string,
  plan: Plan,
): Promise<Harness> {
  const tenant = await pool.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${randomUUID().slice(0, 6)}`],
  );
  const tenantId = tenant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash)
     VALUES ($1, $2, 'placeholder') RETURNING id`,
    [`${name.toLowerCase()}-${randomUUID().slice(0, 6)}@local`, `${name} Admin`],
  );
  const userId = user.rows[0]!.id;
  await pool.query(
    `INSERT INTO memberships (tenant_id, user_id, role)
     VALUES ($1, $2, 'admin')`,
    [tenantId, userId],
  );
  await pool.query(
    `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
     VALUES ($1::uuid, 'local', $1::text, $2)`,
    [userId, `${name.toLowerCase()}@local`],
  );
  const sessionId = `ent-test-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at, active_tenant_id)
     VALUES ($1, $2, now() + interval '1 day', $3)`,
    [sessionId, userId, tenantId],
  );
  await pool.query(
    `INSERT INTO subscriptions
       (tenant_id, plan_id, status, current_period_end)
     VALUES ($1, $2, 'active', now() + interval '1 year')`,
    [tenantId, plan],
  );
  const cookie = `smrtcash_session=${app.signCookie(sessionId)}`;
  return { id: tenantId, userId, cookie };
}

describe('Route entitlement gates (0.15.2)', () => {
  let app: FastifyInstance;
  let starter: Harness;
  let family: Harness;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb({ skipAuth: true });
    starter = await makeTenantWithPlan(app, 'Starter', 'starter');
    family = await makeTenantWithPlan(app, 'Family', 'family');
  });

  function asTenant(h: Harness, opts: InjectOptions) {
    return (app as unknown as { inject: (o: InjectOptions & { skipAuth?: boolean }) => Promise<{
      statusCode: number;
      json: () => Record<string, unknown>;
    }> }).inject({
      ...opts,
      headers: { ...(opts.headers ?? {}), cookie: h.cookie },
      skipAuth: true,
    });
  }

  // ── Bank sync ──────────────────────────────────────────────

  it('Starter is denied POST /api/ofx-dc/connections (402)', async () => {
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (tenant_id, name, type, institution)
       VALUES ($1, 'A', 'checking', 'B') RETURNING id`,
      [starter.id],
    );
    const r = await asTenant(starter, {
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: {
        accountId: acct.rows[0]!.id,
        name: 'Test', ofxUrl: 'https://x', ofxOrg: 'X', ofxFid: '1',
        ofxAppId: 'QWIN', ofxAppVersion: '2700',
        bankAcctId: '1', bankAcctType: 'CHECKING',
        username: 'u', password: 'p', enabled: true,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(402);
  });

  it('Starter is denied POST /api/plaid/link-token (402)', async () => {
    const r = await asTenant(starter, { method: 'POST', url: '/api/plaid/link-token' });
    expect(r.statusCode).toBe(402);
  });

  // ── AI normalize ───────────────────────────────────────────

  it('Starter is denied POST /api/normalize (402)', async () => {
    const r = await asTenant(starter, {
      method: 'POST', url: '/api/normalize',
      payload: {}, headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(402);
  });

  // ── Crypto refresh ─────────────────────────────────────────

  it('Starter is denied POST /api/holdings/refresh-prices/crypto (402)', async () => {
    const r = await asTenant(starter, {
      method: 'POST',
      url: '/api/holdings/refresh-prices/crypto',
    });
    expect(r.statusCode).toBe(402);
  });

  // ── Anomalies ──────────────────────────────────────────────

  it('Starter is denied GET /api/anomalies (402)', async () => {
    const r = await asTenant(starter, { method: 'GET', url: '/api/anomalies' });
    expect(r.statusCode).toBe(402);
  });

  it('Family is granted GET /api/anomalies (200)', async () => {
    const r = await asTenant(family, { method: 'GET', url: '/api/anomalies' });
    expect(r.statusCode).toBe(200);
  });

  // ── Tax reports ────────────────────────────────────────────

  it('Starter is denied GET /api/reports/tax-year/:year (402)', async () => {
    const r = await asTenant(starter, {
      method: 'GET', url: '/api/reports/tax-year/2026',
    });
    expect(r.statusCode).toBe(402);
  });

  // ── Calendar ───────────────────────────────────────────────

  it('Starter is denied GET /api/calendar/:month (402)', async () => {
    const r = await asTenant(starter, {
      method: 'GET', url: '/api/calendar/2026-05',
    });
    expect(r.statusCode).toBe(402);
  });

  // ── Projections ────────────────────────────────────────────

  it('Starter is denied GET /api/projections (402)', async () => {
    const r = await asTenant(starter, { method: 'GET', url: '/api/projections' });
    expect(r.statusCode).toBe(402);
  });

  // ── Bill splitting ─────────────────────────────────────────

  it('Starter and Plus are denied GET /api/split-participants (Family-only)', async () => {
    const plus = await makeTenantWithPlan(app, 'Plus', 'plus');
    for (const h of [starter, plus]) {
      const r = await asTenant(h, { method: 'GET', url: '/api/split-participants' });
      expect(r.statusCode).toBe(402);
    }
    const ok = await asTenant(family, { method: 'GET', url: '/api/split-participants' });
    expect(ok.statusCode).toBe(200);
  });

  // ── AI assistant + quota ───────────────────────────────────

  it('Starter is denied POST /api/assistant/chat (402)', async () => {
    const r = await asTenant(starter, {
      method: 'POST', url: '/api/assistant/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(402);
    expect(String(r.json().error)).toMatch(/upgraded plan|subscription/i);
  });

  it('Plus assistant quota exhaustion returns 402 on the 501st call', async () => {
    const plus = await makeTenantWithPlan(app, 'Plus', 'plus');
    // Burn the quota via the same helper the route uses. This
    // guarantees the `period_start` the route computes matches the
    // row the test creates — both derive from the subscription's
    // `current_period_end` so a single helper call is the truth.
    // (Pre-filling via raw SQL is fragile because the period math
    // would have to be replicated by hand.)
    const burn = await checkAndIncrementQuota(plus.id, FEATURES.AI_ASSISTANT, 500);
    expect(burn.granted).toBe(true);
    expect(burn.remaining).toBe(0);

    const r = await asTenant(plus, {
      method: 'POST', url: '/api/assistant/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'content-type': 'application/json' },
    });
    // Quota check happens BEFORE assistant-availability, so the
    // 402 is deterministic even when Claude isn't configured.
    expect(r.statusCode).toBe(402);
    expect(String(r.json().error)).toMatch(/quota|upgrade/i);
  });

  // ── Multi-currency ─────────────────────────────────────────

  it('Starter is denied POST /api/accounts with non-USD currency (402)', async () => {
    const r = await asTenant(starter, {
      method: 'POST', url: '/api/accounts',
      payload: {
        name: 'Eurochecking', type: 'checking', currency: 'EUR',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(402);
  });

  it('Starter CAN create a USD account (currency gate only triggers on non-USD)', async () => {
    const r = await asTenant(starter, {
      method: 'POST', url: '/api/accounts',
      payload: { name: 'USDchecking', type: 'checking' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
  });

  // ── Household seats ────────────────────────────────────────

  it('Starter is denied POST /api/tenants/:id/invitations (1-seat cap, already at 1)', async () => {
    // Starter cap = 1 member. The admin user IS that 1.
    const r = await asTenant(starter, {
      method: 'POST', url: `/api/tenants/${starter.id}/invitations`,
      payload: { role: 'spouse' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(402);
    expect(String(r.json().error)).toMatch(/seat|limit/i);
  });

  it('Family can invite up to 6 (currently 1 of 6)', async () => {
    const r = await asTenant(family, {
      method: 'POST', url: `/api/tenants/${family.id}/invitations`,
      payload: { role: 'spouse', emailHint: 'spouse@local' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
  });
});
