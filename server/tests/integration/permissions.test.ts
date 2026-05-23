import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';

/**
 * 0.13.4 — per-account permission tuning.
 *
 * Verifies the rbac generalization: spouses can be account-scoped
 * (and per-account read-only), children honor read vs read_write,
 * and admins remain unrestricted.
 */

const TEST_USER = '11111111-1111-1111-1111-111111111111';

async function tenantId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
  );
  return r.rows[0]!.id;
}

async function setRole(role: 'admin' | 'spouse' | 'child') {
  await pool.query(
    `UPDATE memberships SET role = $1
      WHERE user_id = '${TEST_USER}'`,
    [role],
  );
}

async function grantAccess(
  accountId: string,
  permission: 'read' | 'read_write',
) {
  const tid = await tenantId();
  await pool.query(
    `INSERT INTO account_user_access
       (account_id, user_id, tenant_id, permission)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, user_id) DO UPDATE SET permission = EXCLUDED.permission`,
    [accountId, TEST_USER, tid, permission],
  );
}

async function seedTxn(accountId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash)
     VALUES ($1, '2026-05-01', -1234, 'X', $2) RETURNING id`,
    [accountId, `perm-${Math.random()}`],
  );
  return r.rows[0]!.id;
}

describe('Per-account permission tuning (0.13.4)', () => {
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

  it('admin can PATCH any transaction (baseline)', async () => {
    const accountId = await seedAccount();
    const txn = await seedTxn(accountId);
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn}`,
      payload: { merchant: 'Edited' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('spouse without access rows = unrestricted (legacy behavior preserved)', async () => {
    await setRole('spouse');
    const accountId = await seedAccount();
    const txn = await seedTxn(accountId);
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn}`,
      payload: { merchant: 'Spouse edit' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('spouse with read-only access cannot PATCH that account', async () => {
    await setRole('spouse');
    const accountId = await seedAccount();
    await grantAccess(accountId, 'read');
    const txn = await seedTxn(accountId);
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn}`,
      payload: { merchant: 'Locked' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('spouse with read_write access can PATCH that account', async () => {
    await setRole('spouse');
    const accountId = await seedAccount();
    await grantAccess(accountId, 'read_write');
    const txn = await seedTxn(accountId);
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn}`,
      payload: { merchant: 'OK' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
  });

  it("spouse with rows but NOT including this account is blocked", async () => {
    await setRole('spouse');
    const a1 = await seedAccount({ name: 'A1' });
    const a2 = await seedAccount({ name: 'A2' });
    // Grant access to a1 only.
    await grantAccess(a1, 'read_write');
    const otherTxn = await seedTxn(a2);
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${otherTxn}`,
      payload: { merchant: 'Other' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('child with read-only access cannot edit', async () => {
    await setRole('child');
    const accountId = await seedAccount();
    await grantAccess(accountId, 'read');
    const txn = await seedTxn(accountId);
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn}`,
      payload: { merchant: 'Block me' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('child with read_write keeps existing edit capability', async () => {
    await setRole('child');
    const accountId = await seedAccount();
    await grantAccess(accountId, 'read_write');
    const txn = await seedTxn(accountId);
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn}`,
      payload: { merchant: 'Child OK' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('PUT /accounts accepts structured permission payloads', async () => {
    const tid = await tenantId();
    const a1 = await seedAccount({ name: 'A1' });
    const a2 = await seedAccount({ name: 'A2' });
    // We're calling as admin (the default seeded user); we need
    // another user to assign to. Reuse TEST_USER for simplicity —
    // self-grant is unusual but exercises the SQL.
    const r = await app.inject({
      method: 'PUT',
      url: `/api/tenants/${tid}/members/${TEST_USER}/accounts`,
      payload: {
        accounts: [
          { accountId: a1, permission: 'read_write' },
          { accountId: a2, permission: 'read' },
        ],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, count: 2 });

    const list = await app.inject({
      method: 'GET',
      url: `/api/tenants/${tid}/members/${TEST_USER}/accounts`,
    });
    const byId = new Map(
      (list.json().accounts as Array<{ account_id: string; permission: string }>).map(
        (r) => [r.account_id, r.permission],
      ),
    );
    expect(byId.get(a1)).toBe('read_write');
    expect(byId.get(a2)).toBe('read');
  });

  it('legacy accountIds payload still works (default read_write)', async () => {
    const tid = await tenantId();
    const a1 = await seedAccount({ name: 'L1' });
    const r = await app.inject({
      method: 'PUT',
      url: `/api/tenants/${tid}/members/${TEST_USER}/accounts`,
      payload: { accountIds: [a1] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const list = await app.inject({
      method: 'GET',
      url: `/api/tenants/${tid}/members/${TEST_USER}/accounts`,
    });
    const row = (list.json().accounts as Array<{ permission: string }>)[0];
    expect(row!.permission).toBe('read_write');
  });

  it('PUT rejects unknown permission values', async () => {
    const tid = await tenantId();
    const a1 = await seedAccount();
    const r = await app.inject({
      method: 'PUT',
      url: `/api/tenants/${tid}/members/${TEST_USER}/accounts`,
      payload: {
        accounts: [{ accountId: a1, permission: 'admin' }],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });
});
