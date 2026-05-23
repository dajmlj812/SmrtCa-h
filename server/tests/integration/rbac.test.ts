import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, pool, resetDb, seedAccount } from '../setup/test-db.js';

/**
 * Phase 9 RBAC tests. Cover:
 *   • super_admin + tenant membership are mutually exclusive (trigger)
 *   • /api/system/* gated to super_admin
 *   • child scoping on /api/accounts and /api/transactions
 *   • spouse cannot manage members; admin can
 *   • audit log entries land for key actions
 */

async function seedSuperAdmin(email = 'super@local'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, is_super_admin)
     VALUES ($1, 'Super', 'placeholder', true)
     RETURNING id`,
    [email],
  );
  return r.rows[0]!.id;
}

async function seedTenantUser(email: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash)
     VALUES ($1, $1, 'placeholder')
     RETURNING id`,
    [email],
  );
  return r.rows[0]!.id;
}

async function sessionFor(
  userId: string,
  tenantId: string | null,
): Promise<string> {
  const sid = `test-${randomUUID()}`;
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at, active_tenant_id)
     VALUES ($1, $2, now() + interval '1 hour', $3)`,
    [sid, userId, tenantId],
  );
  return sid;
}

describe('RBAC — super_admin / spouse / child (Phase 9)', () => {
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

  // ── Trigger: super_admin cannot have memberships ──────────
  it('inserting a membership for a super_admin throws', async () => {
    const superId = await seedSuperAdmin();
    const tenant = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
    );
    await expect(
      pool.query(
        `INSERT INTO memberships (tenant_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [tenant.rows[0]!.id, superId],
      ),
    ).rejects.toThrow(/super_admin/);
  });

  it('promoting a user to super_admin fails when they have memberships', async () => {
    // Existing test user has a membership; flipping is_super_admin=true must fail.
    await expect(
      pool.query(
        `UPDATE users SET is_super_admin = true
          WHERE id = '11111111-1111-1111-1111-111111111111'`,
      ),
    ).rejects.toThrow(/super_admin/);
  });

  // ── /api/system gating ───────────────────────────────────
  it('/api/system/* returns 403 for tenant users', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/system/tenants',
    });
    expect(r.statusCode).toBe(403);
  });

  it('super_admin can list tenants and the seeded Default is returned', async () => {
    // The seeded test user has a tenant; create a super_admin to act.
    const superId = await seedSuperAdmin();
    const cookie = `smrtcash_session=${app.signCookie(await sessionFor(superId, null))}`;
    const r = await app.inject({
      method: 'GET',
      url: '/api/system/tenants',
      headers: { cookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(200);
    const tenants = r.json().tenants;
    expect(Array.isArray(tenants)).toBe(true);
    expect(tenants.length).toBeGreaterThan(0);
    expect(tenants[0].name).toBe('Default');
    // Critical: payload must NOT include any financial figures.
    expect(tenants[0]).not.toHaveProperty('balance_cents');
  });

  it('super_admin creates a tenant and an audit row lands', async () => {
    const superId = await seedSuperAdmin();
    const cookie = `smrtcash_session=${app.signCookie(await sessionFor(superId, null))}`;
    const r = await app.inject({
      method: 'POST',
      url: '/api/system/tenants',
      payload: { name: 'Smith Family', slug: 'smith' },
      headers: { 'content-type': 'application/json', cookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(201);
    expect(r.json().tenant.slug).toBe('smith');

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action = 'tenant.create'`,
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  // ── Child scoping on accounts/transactions ───────────────
  it('child sees only assigned accounts', async () => {
    const acct1 = await seedAccount({ name: 'Visible' });
    const acct2 = await seedAccount({ name: 'Hidden' });

    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const tenantId = me.json().active_tenant_id;

    const childId = await seedTenantUser('kid@local');
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'child')`,
      [tenantId, childId],
    );
    // Assign ONLY acct1 to the child.
    await pool.query(
      `INSERT INTO account_user_access (account_id, user_id, tenant_id)
       VALUES ($1, $2, $3)`,
      [acct1, childId, tenantId],
    );

    const childCookie = `smrtcash_session=${app.signCookie(await sessionFor(childId, tenantId))}`;
    const r = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie: childCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(200);
    const accounts = r.json().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe('Visible');
    void acct2; // referenced by the negative assertion above
  });

  it('child with no assigned accounts gets an empty list', async () => {
    await seedAccount({ name: 'Off-limits' });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const tenantId = me.json().active_tenant_id;
    const childId = await seedTenantUser('lonelychild@local');
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'child')`,
      [tenantId, childId],
    );
    const cookie = `smrtcash_session=${app.signCookie(await sessionFor(childId, tenantId))}`;
    const r = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.json().accounts).toEqual([]);
  });

  it('child transaction list is scoped to assigned accounts', async () => {
    const visible = await seedAccount({ name: 'Allowance' });
    const hidden = await seedAccount({ name: 'Family card' });
    // Seed one transaction on each.
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-05-01', -500, 'on-allowance', $3),
              ($2, '2026-05-01', -9999, 'on-family-card', $4)`,
      [visible, hidden, randomUUID(), randomUUID()],
    );

    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const tenantId = me.json().active_tenant_id;
    const childId = await seedTenantUser('kid2@local');
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'child')`,
      [tenantId, childId],
    );
    await pool.query(
      `INSERT INTO account_user_access (account_id, user_id, tenant_id)
       VALUES ($1, $2, $3)`,
      [visible, childId, tenantId],
    );

    const childCookie = `smrtcash_session=${app.signCookie(await sessionFor(childId, tenantId))}`;
    const r = await app.inject({
      method: 'GET',
      url: '/api/transactions',
      headers: { cookie: childCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(200);
    const txns = r.json().transactions;
    expect(txns).toHaveLength(1);
    expect(txns[0].raw_description).toBe('on-allowance');
  });

  // ── Spouse cannot manage members ─────────────────────────
  it('spouse cannot create invitations', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const tenantId = me.json().active_tenant_id;
    const spouseId = await seedTenantUser('spouse@local');
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'spouse')`,
      [tenantId, spouseId],
    );
    const cookie = `smrtcash_session=${app.signCookie(await sessionFor(spouseId, tenantId))}`;
    const r = await app.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/invitations`,
      payload: { role: 'child' },
      headers: { 'content-type': 'application/json', cookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(403);
  });

  // ── Account assignment endpoint ──────────────────────────
  it('admin can assign accounts to a child via PUT', async () => {
    const acct1 = await seedAccount({ name: 'A' });
    const acct2 = await seedAccount({ name: 'B' });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const tenantId = me.json().active_tenant_id;
    const childId = await seedTenantUser('child3@local');
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'child')`,
      [tenantId, childId],
    );

    const r = await app.inject({
      method: 'PUT',
      url: `/api/tenants/${tenantId}/members/${childId}/accounts`,
      payload: { accountIds: [acct1, acct2] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().count).toBe(2);

    const got = await app.inject({
      method: 'GET',
      url: `/api/tenants/${tenantId}/members/${childId}/accounts`,
    });
    expect(got.json().accounts).toHaveLength(2);
  });
});
