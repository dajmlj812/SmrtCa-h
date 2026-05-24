import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { resetDb } from '../setup/test-db.js';

/**
 * 0.14.0 — multi-tenant isolation hardening (slice 1: accounts +
 * transactions + holdings).
 *
 * Covers the routes touched by this slice. Each test creates TWO
 * tenants (A and B), populates both, then drives the API as tenant A
 * and asserts that B's data is invisible / immutable from A's
 * session. Reads must NOT return B's rows; writes must 404 (same
 * shape as a non-existent id, so cross-tenant probes can't enumerate
 * ids by status-code diffing).
 *
 * Driving as TWO sessions in the same suite needs a slightly
 * different harness than the rest of the test suite — the shared
 * `makeTestApp()` caches a single test-user cookie tied to the
 * Default tenant. Here we build our own app instance and two real
 * users with their own sessions, one per tenant.
 */

interface TenantHarness {
  id: string;
  userId: string;
  cookie: string;
}

async function makeTenant(
  app: FastifyInstance,
  name: string,
): Promise<TenantHarness> {
  const tenant = await pool.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, name.toLowerCase().replace(/[^a-z0-9]/g, '-')],
  );
  const tenantId = tenant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash)
     VALUES ($1, $2, 'placeholder') RETURNING id`,
    [`${name.toLowerCase()}-admin@local`, `${name} Admin`],
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
    [userId, `${name.toLowerCase()}-admin@local`],
  );
  const sessionId = `iso-test-${name.toLowerCase()}-${userId.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at, active_tenant_id)
     VALUES ($1, $2, now() + interval '1 day', $3)`,
    [sessionId, userId, tenantId],
  );
  // 0.15.2: grant Family/active so the tenant-isolation tests can
  // exercise the gated routes WITHOUT also tripping the entitlement
  // gate (which is tested separately in tests/security/entitlements
  // — when that file lands). Isolation tests care about cross-
  // tenant boundaries, not subscription enforcement.
  await pool.query(
    `INSERT INTO subscriptions
       (tenant_id, plan_id, status, current_period_end)
     VALUES ($1, 'family', 'active', now() + interval '1 year')`,
    [tenantId],
  );
  const cookie = `smrtcash_session=${app.signCookie(sessionId)}`;
  return { id: tenantId, userId, cookie };
}

async function seedAccountFor(
  tenantId: string,
  name: string,
  type = 'checking',
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO accounts (tenant_id, name, type, institution, last4)
     VALUES ($1, $2, $3, 'Bank', '0000') RETURNING id`,
    [tenantId, name, type],
  );
  return r.rows[0]!.id;
}

async function seedTxnFor(opts: {
  accountId: string;
  date: string;
  amountCents: number;
  raw: string;
}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, txn_date, amount_cents, raw_description, dedup_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [opts.accountId, opts.date, opts.amountCents, opts.raw, randomUUID()],
  );
  return r.rows[0]!.id;
}

async function seedHoldingFor(opts: {
  tenantId: string;
  accountId: string;
  symbol: string;
}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO holdings
       (tenant_id, account_id, symbol, name, asset_type, quantity,
        last_price_cents)
     VALUES ($1, $2, $3, $3, 'stock', 10, 10000) RETURNING id`,
    [opts.tenantId, opts.accountId, opts.symbol],
  );
  return r.rows[0]!.id;
}

describe('Tenant isolation — accounts + transactions + holdings (0.14.0)', () => {
  let app: FastifyInstance;
  let A: TenantHarness;
  let B: TenantHarness;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb({ skipAuth: true });
    A = await makeTenant(app, 'TenantA');
    B = await makeTenant(app, 'TenantB');
  });

  /** Inject as tenant A with no auto-attached cookie. */
  function asA(opts: InjectOptions) {
    return (app as unknown as { inject: (o: InjectOptions & { skipAuth?: boolean }) => Promise<{
      statusCode: number;
      json: () => Record<string, unknown>;
      payload: string;
    }> }).inject({
      ...opts,
      headers: { ...(opts.headers ?? {}), cookie: A.cookie },
      skipAuth: true,
    });
  }

  // ── Accounts ────────────────────────────────────────────────

  it('GET /api/accounts shows only the caller-tenant rows', async () => {
    await seedAccountFor(A.id, 'A-Checking');
    await seedAccountFor(B.id, 'B-Checking');
    const r = await asA({ method: 'GET', url: '/api/accounts' });
    expect(r.statusCode).toBe(200);
    const names = (r.json().accounts as Array<{ name: string }>).map((a) => a.name);
    expect(names).toEqual(['A-Checking']);
  });

  it('GET /api/accounts/:id 404s a cross-tenant account', async () => {
    const bAcct = await seedAccountFor(B.id, 'B-Checking');
    const r = await asA({ method: 'GET', url: `/api/accounts/${bAcct}` });
    expect(r.statusCode).toBe(404);
  });

  it('PATCH /api/accounts/:id 404s a cross-tenant account (no mutation)', async () => {
    const bAcct = await seedAccountFor(B.id, 'B-Original');
    const r = await asA({
      method: 'PATCH',
      url: `/api/accounts/${bAcct}`,
      payload: { name: 'Hacked by A' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
    const after = await pool.query<{ name: string }>(
      `SELECT name FROM accounts WHERE id = $1`,
      [bAcct],
    );
    expect(after.rows[0]!.name).toBe('B-Original');
  });

  it('DELETE /api/accounts/:id 404s a cross-tenant account (no deletion)', async () => {
    const bAcct = await seedAccountFor(B.id, 'B-Keep');
    const r = await asA({ method: 'DELETE', url: `/api/accounts/${bAcct}` });
    expect(r.statusCode).toBe(404);
    const after = await pool.query(`SELECT 1 FROM accounts WHERE id = $1`, [bAcct]);
    expect(after.rowCount).toBe(1);
  });

  it('POST /api/accounts writes tenant_id from session, not body', async () => {
    const r = await asA({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        name: 'A-New',
        type: 'checking',
        tenant_id: B.id, // body attempts to set B; must be ignored.
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
    const newId = (r.json().account as { id: string }).id;
    const row = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM accounts WHERE id = $1`,
      [newId],
    );
    expect(row.rows[0]!.tenant_id).toBe(A.id);
  });

  // ── Transactions ────────────────────────────────────────────

  it('GET /api/transactions never returns cross-tenant rows', async () => {
    const aAcct = await seedAccountFor(A.id, 'A');
    const bAcct = await seedAccountFor(B.id, 'B');
    await seedTxnFor({ accountId: aAcct, date: '2026-05-01', amountCents: -100, raw: 'A-PURCHASE' });
    await seedTxnFor({ accountId: bAcct, date: '2026-05-01', amountCents: -200, raw: 'B-SECRET' });
    const r = await asA({ method: 'GET', url: '/api/transactions' });
    expect(r.statusCode).toBe(200);
    const descs = (r.json().transactions as Array<{ raw_description: string }>).map(
      (t) => t.raw_description,
    );
    expect(descs).toEqual(['A-PURCHASE']);
  });

  it('GET /api/transactions with cross-tenant accountId returns empty', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    await seedTxnFor({ accountId: bAcct, date: '2026-05-01', amountCents: -100, raw: 'B-SECRET' });
    const r = await asA({
      method: 'GET',
      url: `/api/transactions?accountId=${bAcct}`,
    });
    expect(r.statusCode).toBe(200);
    expect((r.json().transactions as unknown[]).length).toBe(0);
  });

  it('GET /api/transactions/export omits cross-tenant rows', async () => {
    const aAcct = await seedAccountFor(A.id, 'A');
    const bAcct = await seedAccountFor(B.id, 'B');
    await seedTxnFor({ accountId: aAcct, date: '2026-05-01', amountCents: -100, raw: 'A-PURCHASE' });
    await seedTxnFor({ accountId: bAcct, date: '2026-05-01', amountCents: -200, raw: 'B-SECRET' });
    const r = await asA({ method: 'GET', url: '/api/transactions/export' });
    expect(r.statusCode).toBe(200);
    expect(r.payload).toContain('A-PURCHASE');
    expect(r.payload).not.toContain('B-SECRET');
  });

  it('PATCH /api/transactions/:id 404s a cross-tenant transaction', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    const bTxn = await seedTxnFor({ accountId: bAcct, date: '2026-05-01', amountCents: -100, raw: 'B-ORIG' });
    const r = await asA({
      method: 'PATCH',
      url: `/api/transactions/${bTxn}`,
      payload: { merchant: 'HACKED' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
    const after = await pool.query<{ normalized_merchant: string | null }>(
      `SELECT normalized_merchant FROM transactions WHERE id = $1`,
      [bTxn],
    );
    expect(after.rows[0]!.normalized_merchant).toBeNull();
  });

  it('POST /api/transactions/bulk-delete silently filters cross-tenant ids', async () => {
    const aAcct = await seedAccountFor(A.id, 'A');
    const bAcct = await seedAccountFor(B.id, 'B');
    const aTxn = await seedTxnFor({ accountId: aAcct, date: '2026-05-01', amountCents: -100, raw: 'A' });
    const bTxn = await seedTxnFor({ accountId: bAcct, date: '2026-05-01', amountCents: -200, raw: 'B' });
    const r = await asA({
      method: 'POST',
      url: '/api/transactions/bulk-delete',
      payload: { ids: [aTxn, bTxn] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().deleted).toBe(1);
    // B's row survived.
    const bStill = await pool.query(`SELECT 1 FROM transactions WHERE id = $1`, [bTxn]);
    expect(bStill.rowCount).toBe(1);
    // A's row gone.
    const aGone = await pool.query(`SELECT 1 FROM transactions WHERE id = $1`, [aTxn]);
    expect(aGone.rowCount).toBe(0);
  });

  it('PATCH /api/transactions/bulk silently skips cross-tenant ids', async () => {
    const aAcct = await seedAccountFor(A.id, 'A');
    const bAcct = await seedAccountFor(B.id, 'B');
    const aTxn = await seedTxnFor({ accountId: aAcct, date: '2026-05-01', amountCents: -100, raw: 'A' });
    const bTxn = await seedTxnFor({ accountId: bAcct, date: '2026-05-01', amountCents: -200, raw: 'B' });
    const r = await asA({
      method: 'PATCH',
      url: '/api/transactions/bulk',
      payload: { ids: [aTxn, bTxn], updates: { merchant: 'TOUCHED' } },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().updated).toBe(1);
    const rows = await pool.query<{ id: string; normalized_merchant: string | null }>(
      `SELECT id, normalized_merchant FROM transactions WHERE id = ANY($1::uuid[])`,
      [[aTxn, bTxn]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.normalized_merchant]));
    expect(byId.get(aTxn)).toBe('TOUCHED');
    expect(byId.get(bTxn)).toBeNull();
  });

  it("PATCH /api/transactions/:id rejects a cross-tenant categoryId", async () => {
    // A has an account + txn. B owns a private (tenant-scoped) category.
    const aAcct = await seedAccountFor(A.id, 'A');
    const aTxn = await seedTxnFor({ accountId: aAcct, date: '2026-05-01', amountCents: -100, raw: 'A' });
    const bCat = await pool.query<{ id: string }>(
      `INSERT INTO categories (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [B.id, 'B Private Cat'],
    );
    const r = await asA({
      method: 'PATCH',
      url: `/api/transactions/${aTxn}`,
      payload: { categoryId: bCat.rows[0]!.id },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  // ── Holdings ────────────────────────────────────────────────

  it('GET /api/holdings shows only the caller-tenant rows', async () => {
    const aAcct = await seedAccountFor(A.id, 'A-Inv', 'investment');
    const bAcct = await seedAccountFor(B.id, 'B-Inv', 'investment');
    await seedHoldingFor({ tenantId: A.id, accountId: aAcct, symbol: 'AAA' });
    await seedHoldingFor({ tenantId: B.id, accountId: bAcct, symbol: 'BBB' });
    const r = await asA({ method: 'GET', url: '/api/holdings' });
    expect(r.statusCode).toBe(200);
    const syms = (r.json().holdings as Array<{ symbol: string }>).map((h) => h.symbol);
    expect(syms).toEqual(['AAA']);
  });

  it('POST /api/holdings rejects a cross-tenant accountId (404)', async () => {
    const bAcct = await seedAccountFor(B.id, 'B-Inv', 'investment');
    const r = await asA({
      method: 'POST',
      url: '/api/holdings',
      payload: {
        accountId: bAcct,
        name: 'Hack',
        symbol: 'HACK',
        quantity: 1,
        lastPriceCents: 100,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('PATCH /api/holdings/:id 404s a cross-tenant holding', async () => {
    const bAcct = await seedAccountFor(B.id, 'B-Inv', 'investment');
    const bH = await seedHoldingFor({ tenantId: B.id, accountId: bAcct, symbol: 'ORIG' });
    const r = await asA({
      method: 'PATCH',
      url: `/api/holdings/${bH}`,
      payload: { symbol: 'HACK' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
    const after = await pool.query<{ symbol: string }>(
      `SELECT symbol FROM holdings WHERE id = $1`,
      [bH],
    );
    expect(after.rows[0]!.symbol).toBe('ORIG');
  });

  it('DELETE /api/holdings/:id 404s a cross-tenant holding (no deletion)', async () => {
    const bAcct = await seedAccountFor(B.id, 'B-Inv', 'investment');
    const bH = await seedHoldingFor({ tenantId: B.id, accountId: bAcct, symbol: 'KEEP' });
    const r = await asA({ method: 'DELETE', url: `/api/holdings/${bH}` });
    expect(r.statusCode).toBe(404);
    const still = await pool.query(`SELECT 1 FROM holdings WHERE id = $1`, [bH]);
    expect(still.rowCount).toBe(1);
  });

  // ── Budgets (0.14.1) ────────────────────────────────────────

  async function seedBudgetFor(tenantId: string, amountCents: number, periodMonth = '2026-05-01'): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO budgets (tenant_id, period_month, period_type, amount_cents)
       VALUES ($1, $2::date, 'monthly', $3) RETURNING id`,
      [tenantId, periodMonth, amountCents],
    );
    return r.rows[0]!.id;
  }

  it('GET /api/budgets returns only caller-tenant rows', async () => {
    await seedBudgetFor(A.id, 1000);
    await seedBudgetFor(B.id, 2000);
    const r = await asA({ method: 'GET', url: '/api/budgets?all=1' });
    expect(r.statusCode).toBe(200);
    const amounts = (r.json().budgets as Array<{ amount_cents: number }>).map(
      (b) => Number(b.amount_cents),
    );
    expect(amounts).toEqual([1000]);
  });

  it('PATCH /api/budgets/:id 404s a cross-tenant budget', async () => {
    const bBudget = await seedBudgetFor(B.id, 5000);
    const r = await asA({
      method: 'PATCH',
      url: `/api/budgets/${bBudget}`,
      payload: { amountCents: 99 },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
    const after = await pool.query<{ amount_cents: number }>(
      `SELECT amount_cents FROM budgets WHERE id = $1`,
      [bBudget],
    );
    expect(Number(after.rows[0]!.amount_cents)).toBe(5000);
  });

  it('DELETE /api/budgets/:id 404s a cross-tenant budget', async () => {
    const bBudget = await seedBudgetFor(B.id, 3000);
    const r = await asA({ method: 'DELETE', url: `/api/budgets/${bBudget}` });
    expect(r.statusCode).toBe(404);
    const still = await pool.query(`SELECT 1 FROM budgets WHERE id = $1`, [bBudget]);
    expect(still.rowCount).toBe(1);
  });

  it('POST /api/budgets/copy only copies caller-tenant source', async () => {
    await seedBudgetFor(A.id, 100, '2026-04-01');
    await seedBudgetFor(B.id, 999, '2026-04-01');
    const r = await asA({
      method: 'POST',
      url: '/api/budgets/copy',
      payload: { fromMonth: '2026-04-01', toMonth: '2026-05-01' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().copied).toBe(1);
    // Tenant A now has a 100-cent May budget; B is untouched.
    const after = await pool.query<{ tenant_id: string; amount_cents: number }>(
      `SELECT tenant_id, amount_cents FROM budgets
        WHERE period_month = '2026-05-01' ORDER BY amount_cents`,
    );
    const byTenant = new Map(after.rows.map((r) => [r.tenant_id, Number(r.amount_cents)]));
    expect(byTenant.get(A.id)).toBe(100);
    expect(byTenant.has(B.id)).toBe(false);
  });

  it('budget actual aggregates only this tenant\'s transactions', async () => {
    // Both tenants have an account with a $500 expense in May.
    const aAcct = await seedAccountFor(A.id, 'A');
    const bAcct = await seedAccountFor(B.id, 'B');
    // Use a global "Groceries" category that exists per the default seed.
    const cat = await pool.query<{ id: string }>(
      `SELECT id FROM categories WHERE name = 'Groceries' LIMIT 1`,
    );
    const catId = cat.rows[0]!.id;
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash, category_id)
       VALUES ($1, '2026-05-10', -50000, 'A-GROC', $3, $4),
              ($2, '2026-05-10', -50000, 'B-GROC', $5, $4)`,
      [aAcct, bAcct, randomUUID(), catId, randomUUID()],
    );
    // A has a $1000 monthly budget for Groceries.
    await pool.query(
      `INSERT INTO budgets (tenant_id, period_month, period_type, category_id, amount_cents)
       VALUES ($1, '2026-05-01'::date, 'monthly', $2, 100000)`,
      [A.id, catId],
    );
    const r = await asA({
      method: 'GET',
      url: '/api/budgets/actual?month=2026-05-01',
    });
    expect(r.statusCode).toBe(200);
    const grocRow = (r.json().rows as Array<{ category_id: string; actual_cents: number }>).find(
      (x) => x.category_id === catId,
    );
    expect(grocRow!.actual_cents).toBe(50000); // not 100000 — B's spend doesn't bleed in
  });

  it("POST /api/budgets rejects a cross-tenant categoryId", async () => {
    const bCat = await pool.query<{ id: string }>(
      `INSERT INTO categories (tenant_id, name) VALUES ($1, 'B Private') RETURNING id`,
      [B.id],
    );
    const r = await asA({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        periodStart: '2026-05-01',
        amountCents: 1000,
        categoryId: bCat.rows[0]!.id,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  // ── Bills + recurring-income + cash-flow (0.14.1) ───────────

  async function seedBillFor(tenantId: string, name: string, amountCents = 1000): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO bills (tenant_id, name, amount_cents, frequency, next_due_date, active)
       VALUES ($1, $2, $3, 'monthly', now()::date + 7, true) RETURNING id`,
      [tenantId, name, amountCents],
    );
    return r.rows[0]!.id;
  }

  it('GET /api/bills returns only caller-tenant rows', async () => {
    await seedBillFor(A.id, 'A-Rent');
    await seedBillFor(B.id, 'B-Rent');
    const r = await asA({ method: 'GET', url: '/api/bills' });
    expect(r.statusCode).toBe(200);
    const names = (r.json().bills as Array<{ name: string }>).map((b) => b.name);
    expect(names).toEqual(['A-Rent']);
  });

  it('PATCH/DELETE /api/bills/:id 404 a cross-tenant bill', async () => {
    const bBill = await seedBillFor(B.id, 'B-Rent');
    const patch = await asA({
      method: 'PATCH',
      url: `/api/bills/${bBill}`,
      payload: { name: 'HACKED' },
      headers: { 'content-type': 'application/json' },
    });
    expect(patch.statusCode).toBe(404);
    const del = await asA({ method: 'DELETE', url: `/api/bills/${bBill}` });
    expect(del.statusCode).toBe(404);
    const after = await pool.query<{ name: string }>(
      `SELECT name FROM bills WHERE id = $1`,
      [bBill],
    );
    expect(after.rows[0]!.name).toBe('B-Rent');
  });

  it('POST /api/bills rejects a cross-tenant accountId and categoryId', async () => {
    const bAcct = await seedAccountFor(B.id, 'B-Check');
    const r1 = await asA({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'X',
        amountCents: 100,
        frequency: 'monthly',
        nextDueDate: '2026-06-01',
        accountId: bAcct,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r1.statusCode).toBe(400);

    const bCat = await pool.query<{ id: string }>(
      `INSERT INTO categories (tenant_id, name) VALUES ($1, 'B Cat') RETURNING id`,
      [B.id],
    );
    const r2 = await asA({
      method: 'POST',
      url: '/api/bills',
      payload: {
        name: 'X',
        amountCents: 100,
        frequency: 'monthly',
        nextDueDate: '2026-06-01',
        categoryId: bCat.rows[0]!.id,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r2.statusCode).toBe(400);
  });

  it('GET /api/recurring-income returns only caller-tenant rows', async () => {
    await pool.query(
      `INSERT INTO recurring_income (tenant_id, name, amount_cents, frequency, next_expected_date, active)
       VALUES ($1, 'A-Salary', 200000, 'monthly', now()::date + 14, true),
              ($2, 'B-Salary', 300000, 'monthly', now()::date + 14, true)`,
      [A.id, B.id],
    );
    const r = await asA({ method: 'GET', url: '/api/recurring-income' });
    expect(r.statusCode).toBe(200);
    const names = (r.json().income as Array<{ name: string }>).map((i) => i.name);
    expect(names).toEqual(['A-Salary']);
  });

  it('GET /api/cash-flow projects only caller-tenant accounts + events', async () => {
    // A has $1000 opening, $200 monthly bill. B has $50000 opening, $5000 bill.
    // A's forecast should NEVER include B's numbers.
    await pool.query(
      `INSERT INTO accounts (tenant_id, name, type, institution, opening_balance_cents)
       VALUES ($1, 'A', 'checking', 'X', 100000),
              ($2, 'B', 'checking', 'X', 5000000)`,
      [A.id, B.id],
    );
    await seedBillFor(A.id, 'A-Bill', 20000);
    await seedBillFor(B.id, 'B-Bill', 500000);
    const r = await asA({ method: 'GET', url: '/api/cash-flow?days=30' });
    expect(r.statusCode).toBe(200);
    expect(r.json().starting_cents).toBe(100000); // A's $1000, NOT $51000
  });

  // ── Goals (0.14.1) ──────────────────────────────────────────

  it('GET /api/goals returns only caller-tenant rows', async () => {
    await pool.query(
      `INSERT INTO savings_goals (tenant_id, name, target_amount_cents, current_amount_cents)
       VALUES ($1, 'A-Emergency', 1000000, 100000),
              ($2, 'B-Vacation', 500000, 50000)`,
      [A.id, B.id],
    );
    const r = await asA({ method: 'GET', url: '/api/goals' });
    expect(r.statusCode).toBe(200);
    const names = (r.json().goals as Array<{ name: string }>).map((g) => g.name);
    expect(names).toEqual(['A-Emergency']);
  });

  it('PATCH/DELETE /api/goals/:id 404 a cross-tenant goal', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO savings_goals (tenant_id, name, target_amount_cents)
       VALUES ($1, 'B-Goal', 100000) RETURNING id`,
      [B.id],
    );
    const id = r.rows[0]!.id;
    const patch = await asA({
      method: 'PATCH',
      url: `/api/goals/${id}`,
      payload: { name: 'HACKED' },
      headers: { 'content-type': 'application/json' },
    });
    expect(patch.statusCode).toBe(404);
    const del = await asA({ method: 'DELETE', url: `/api/goals/${id}` });
    expect(del.statusCode).toBe(404);
  });

  // ── Recurring + subscriptions (0.14.1) ──────────────────────

  it('GET /api/recurring/suggestions returns only caller-tenant rows', async () => {
    await pool.query(
      `INSERT INTO recurring_suggestions
         (tenant_id, kind, name, normalized_key, amount_cents,
          detected_frequency, sample_txn_ids, confidence)
       VALUES ($1, 'bill', 'A-Netflix', 'A-NETFLIX', 1499, 'monthly', ARRAY[]::uuid[], 0.9),
              ($2, 'bill', 'B-Netflix', 'B-NETFLIX', 1499, 'monthly', ARRAY[]::uuid[], 0.9)`,
      [A.id, B.id],
    );
    const r = await asA({ method: 'GET', url: '/api/recurring/suggestions' });
    expect(r.statusCode).toBe(200);
    const names = (r.json().suggestions as Array<{ name: string }>).map((s) => s.name);
    expect(names).toEqual(['A-Netflix']);
  });

  it('POST /api/recurring/detect only sees caller-tenant transactions', async () => {
    const aAcct = await seedAccountFor(A.id, 'A');
    const bAcct = await seedAccountFor(B.id, 'B');
    // Three "A-NETFLIX" charges (recurring detector needs >= 3 to fire).
    for (const date of ['2026-03-15', '2026-04-15', '2026-05-15']) {
      await seedTxnFor({ accountId: aAcct, date, amountCents: -1499, raw: 'A-NETFLIX' });
      await seedTxnFor({ accountId: bAcct, date, amountCents: -1499, raw: 'B-NETFLIX' });
    }
    const r = await asA({ method: 'POST', url: '/api/recurring/detect' });
    expect(r.statusCode).toBe(200);
    // Only A's txns were scanned (3, not 6).
    expect(r.json().scanned).toBe(3);
    // Suggestions table now has only A-NETFLIX for tenant A.
    const sugs = await pool.query<{ tenant_id: string; name: string }>(
      `SELECT tenant_id, name FROM recurring_suggestions`,
    );
    expect(sugs.rows.every((s) => s.tenant_id === A.id)).toBe(true);
    expect(sugs.rows.every((s) => s.name.includes('A-NETFLIX') || s.name.includes('A'))).toBe(true);
  });

  it("POST /api/recurring/suggestions/:id/reject 404s a cross-tenant suggestion", async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO recurring_suggestions
         (tenant_id, kind, name, normalized_key, amount_cents,
          detected_frequency, sample_txn_ids, confidence)
       VALUES ($1, 'bill', 'B', 'B', 1, 'monthly', ARRAY[]::uuid[], 0.9)
       RETURNING id`,
      [B.id],
    );
    const reject = await asA({
      method: 'POST',
      url: `/api/recurring/suggestions/${r.rows[0]!.id}/reject`,
    });
    expect(reject.statusCode).toBe(404);
  });

  it('GET /api/subscriptions/candidates returns only caller-tenant rows', async () => {
    await pool.query(
      `INSERT INTO recurring_suggestions
         (tenant_id, kind, name, normalized_key, amount_cents,
          detected_frequency, sample_txn_ids, confidence, status)
       VALUES ($1, 'bill', 'A-Sub', 'A-SUB', 999, 'monthly', ARRAY[]::uuid[], 0.9, 'pending'),
              ($2, 'bill', 'B-Sub', 'B-SUB', 999, 'monthly', ARRAY[]::uuid[], 0.9, 'pending')`,
      [A.id, B.id],
    );
    const r = await asA({ method: 'GET', url: '/api/subscriptions/candidates' });
    expect(r.statusCode).toBe(200);
    const names = (r.json().candidates as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(['A-Sub']);
  });

  // ── Insights + reports + transfers (0.14.2) ─────────────────

  it('GET /api/insights/spending-by-category omits cross-tenant spending', async () => {
    const aAcct = await seedAccountFor(A.id, 'A');
    const bAcct = await seedAccountFor(B.id, 'B');
    const cat = await pool.query<{ id: string }>(
      `SELECT id FROM categories WHERE name = 'Groceries' LIMIT 1`,
    );
    const catId = cat.rows[0]!.id;
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash, category_id)
       VALUES ($1, '2026-05-10', -50000, 'A-GROC', $3, $4),
              ($2, '2026-05-10', -50000, 'B-GROC', $5, $4)`,
      [aAcct, bAcct, randomUUID(), catId, randomUUID()],
    );
    const r = await asA({
      method: 'GET',
      url: '/api/insights/spending-by-category?start=2026-05-01&end=2026-05-31',
    });
    expect(r.statusCode).toBe(200);
    const grocRow = (r.json().rows as Array<{ category_id: string; total_cents: number }>).find(
      (x) => x.category_id === catId,
    );
    // A's $500, not $1000.
    expect(Number(grocRow!.total_cents)).toBe(50000);
  });

  it('GET /api/insights/spending-by-category with cross-tenant accountId 404s', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    const r = await asA({
      method: 'GET',
      url: `/api/insights/spending-by-category?accountId=${bAcct}&start=2026-05-01&end=2026-05-31`,
    });
    expect(r.statusCode).toBe(404);
  });

  it('GET /api/insights/income-expense aggregates only caller-tenant rows', async () => {
    const aAcct = await seedAccountFor(A.id, 'A');
    const bAcct = await seedAccountFor(B.id, 'B');
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, $3, 100000, 'A-INCOME', $4),
              ($2, $3, 999999, 'B-INCOME', $5)`,
      [aAcct, bAcct, today, randomUUID(), randomUUID()],
    );
    const r = await asA({ method: 'GET', url: '/api/insights/income-expense?months=1' });
    expect(r.statusCode).toBe(200);
    const totalIncome = (r.json().rows as Array<{ income_cents: number }>).reduce(
      (s, row) => s + Number(row.income_cents),
      0,
    );
    expect(totalIncome).toBe(100000);
  });

  it('GET /api/insights/net-worth-over-time sums only caller-tenant accounts + holdings', async () => {
    await pool.query(
      `INSERT INTO accounts (tenant_id, name, type, institution, opening_balance_cents)
       VALUES ($1, 'A', 'checking', 'X', 100000),
              ($2, 'B', 'checking', 'X', 9999999)`,
      [A.id, B.id],
    );
    const r = await asA({ method: 'GET', url: '/api/insights/net-worth-over-time?months=1' });
    expect(r.statusCode).toBe(200);
    const row = (r.json().rows as Array<{ net_worth_cents: number }>)[0]!;
    expect(Number(row.net_worth_cents)).toBe(100000);
  });

  // Reports — each one should sum/list only the caller tenant's data.
  it('POST /api/reports/top-merchants/run returns only caller-tenant merchants', async () => {
    const aAcct = await seedAccountFor(A.id, 'A');
    const bAcct = await seedAccountFor(B.id, 'B');
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash, normalized_merchant)
       VALUES ($1, '2026-05-01', -1000, 'A', $3, 'A-Starbucks'),
              ($2, '2026-05-01', -1000, 'B', $4, 'B-Costco')`,
      [aAcct, bAcct, randomUUID(), randomUUID()],
    );
    const r = await asA({
      method: 'POST',
      url: '/api/reports/top-merchants/run',
      payload: { start: '2026-05-01', end: '2026-05-31' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const merchants = (r.json().result.rows as Array<{ merchant: string }>).map(
      (m) => m.merchant,
    );
    expect(merchants).toEqual(['A-Starbucks']);
  });

  it('POST /api/reports/subscription-costs/run shows only caller-tenant bills', async () => {
    await pool.query(
      `INSERT INTO bills (tenant_id, name, amount_cents, frequency, next_due_date, active)
       VALUES ($1, 'A-Netflix', 1499, 'monthly', now()::date + 7, true),
              ($2, 'B-HBO',     1999, 'monthly', now()::date + 7, true)`,
      [A.id, B.id],
    );
    const r = await asA({
      method: 'POST',
      url: '/api/reports/subscription-costs/run',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const names = (r.json().result.rows as Array<{ name: string }>).map((x) => x.name);
    expect(names).toEqual(['A-Netflix']);
  });

  // Transfers — detect must not pair across tenants; link/unlink scoped.
  it('POST /api/transfers/detect does NOT pair across tenants', async () => {
    // A debit on Tenant A + a credit on Tenant B with matching amounts +
    // matching dates would have been auto-paired pre-0.14.2.
    const aAcct = await seedAccountFor(A.id, 'A-Check');
    const bAcct = await seedAccountFor(B.id, 'B-Check');
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-05-01', -50000, 'A-OUT', $3),
              ($2, '2026-05-02', 50000, 'B-IN', $4)`,
      [aAcct, bAcct, randomUUID(), randomUUID()],
    );
    const r = await asA({ method: 'POST', url: '/api/transfers/detect' });
    expect(r.statusCode).toBe(200);
    expect(r.json().summary.paired).toBe(0);
    // Neither row got a transfer_group_id.
    const groups = await pool.query<{ transfer_group_id: string | null }>(
      `SELECT transfer_group_id FROM transactions
        WHERE raw_description IN ('A-OUT', 'B-IN')`,
    );
    expect(groups.rows.every((g) => g.transfer_group_id === null)).toBe(true);
  });

  it("POST /api/transfers refuses cross-tenant aId/bId", async () => {
    const aAcct = await seedAccountFor(A.id, 'A-Check');
    const bAcct = await seedAccountFor(B.id, 'B-Check');
    const aTxn = await seedTxnFor({
      accountId: aAcct, date: '2026-05-01', amountCents: -1000, raw: 'A',
    });
    const bTxn = await seedTxnFor({
      accountId: bAcct, date: '2026-05-01', amountCents: 1000, raw: 'B',
    });
    const r = await asA({
      method: 'POST',
      url: '/api/transfers',
      payload: { aId: aTxn, bId: bTxn },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
    expect(String(r.json().error)).toMatch(/not found/i);
  });

  it("DELETE /api/transfers/:groupId 404s a cross-tenant group", async () => {
    // Set up a real transfer group entirely within Tenant B.
    const bA = await seedAccountFor(B.id, 'B-1');
    const bB = await seedAccountFor(B.id, 'B-2');
    const groupId = randomUUID();
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash, transfer_group_id)
       VALUES ($1, '2026-05-01', -1000, 'B-OUT', $3, $5),
              ($2, '2026-05-01', 1000,  'B-IN',  $4, $5)`,
      [bA, bB, randomUUID(), randomUUID(), groupId],
    );
    const r = await asA({ method: 'DELETE', url: `/api/transfers/${groupId}` });
    expect(r.statusCode).toBe(404);
    // Group still intact.
    const still = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM transactions WHERE transfer_group_id = $1`,
      [groupId],
    );
    expect(Number(still.rows[0]!.count)).toBe(2);
  });

  // ── Attachments (0.14.3) ────────────────────────────────────

  async function seedAttachmentFor(
    tenantId: string,
    accountId: string,
  ): Promise<{ attachmentId: string; txnId: string }> {
    const txnId = await seedTxnFor({
      accountId, date: '2026-05-01', amountCents: -1000, raw: 'X',
    });
    const att = await pool.query<{ id: string }>(
      `INSERT INTO attachments
         (tenant_id, transaction_id, filename, mime_type, byte_size,
          storage_path, encryption_version)
       VALUES ($1, $2, 'receipt.pdf', 'application/pdf', 100, '/tmp/fake', 0)
       RETURNING id`,
      [tenantId, txnId],
    );
    return { attachmentId: att.rows[0]!.id, txnId };
  }

  it('GET /api/transactions/:id/attachments 404s a cross-tenant txn', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    const { txnId } = await seedAttachmentFor(B.id, bAcct);
    const r = await asA({
      method: 'GET',
      url: `/api/transactions/${txnId}/attachments`,
    });
    expect(r.statusCode).toBe(404);
  });

  it('GET /api/attachments/:id (download) 404s a cross-tenant attachment', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    const { attachmentId } = await seedAttachmentFor(B.id, bAcct);
    const r = await asA({ method: 'GET', url: `/api/attachments/${attachmentId}` });
    expect(r.statusCode).toBe(404);
  });

  it('GET /api/attachments/:id/preview 404s a cross-tenant attachment', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    const { attachmentId } = await seedAttachmentFor(B.id, bAcct);
    const r = await asA({
      method: 'GET',
      url: `/api/attachments/${attachmentId}/preview`,
    });
    expect(r.statusCode).toBe(404);
  });

  it('DELETE /api/attachments/:id 404s a cross-tenant attachment (no deletion)', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    const { attachmentId } = await seedAttachmentFor(B.id, bAcct);
    const r = await asA({ method: 'DELETE', url: `/api/attachments/${attachmentId}` });
    expect(r.statusCode).toBe(404);
    const still = await pool.query(`SELECT 1 FROM attachments WHERE id = $1`, [attachmentId]);
    expect(still.rowCount).toBe(1);
  });

  // ── Splits (0.14.3) ─────────────────────────────────────────

  it('GET /api/transactions/:id/splits 404s a cross-tenant txn', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    const bTxn = await seedTxnFor({
      accountId: bAcct, date: '2026-05-01', amountCents: -1000, raw: 'B',
    });
    const r = await asA({
      method: 'GET',
      url: `/api/transactions/${bTxn}/splits`,
    });
    expect(r.statusCode).toBe(404);
  });

  it('PUT /api/transactions/:id/splits 404s a cross-tenant txn (no mutation)', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    const bTxn = await seedTxnFor({
      accountId: bAcct, date: '2026-05-01', amountCents: -10000, raw: 'B',
    });
    const cat = await pool.query<{ id: string }>(
      `SELECT id FROM categories WHERE name = 'Groceries' LIMIT 1`,
    );
    const r = await asA({
      method: 'PUT',
      url: `/api/transactions/${bTxn}/splits`,
      payload: {
        splits: [{ categoryId: cat.rows[0]!.id, amountCents: -10000 }],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
    const noSplits = await pool.query(
      `SELECT 1 FROM transaction_splits WHERE transaction_id = $1`,
      [bTxn],
    );
    expect(noSplits.rowCount).toBe(0);
  });

  it("PUT /api/transactions/:id/splits rejects a cross-tenant categoryId per split", async () => {
    const aAcct = await seedAccountFor(A.id, 'A');
    const aTxn = await seedTxnFor({
      accountId: aAcct, date: '2026-05-01', amountCents: -10000, raw: 'A',
    });
    const bCat = await pool.query<{ id: string }>(
      `INSERT INTO categories (tenant_id, name) VALUES ($1, 'B-Cat') RETURNING id`,
      [B.id],
    );
    const r = await asA({
      method: 'PUT',
      url: `/api/transactions/${aTxn}/splits`,
      payload: {
        splits: [{ categoryId: bCat.rows[0]!.id, amountCents: -10000 }],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  // ── Suggestions (0.14.3) ────────────────────────────────────

  it('GET /api/suggestions returns only caller-tenant rows', async () => {
    await pool.query(
      `INSERT INTO category_suggestions (tenant_id, suggested_name)
       VALUES ($1, 'A-Suggestion'), ($2, 'B-Suggestion')`,
      [A.id, B.id],
    );
    const r = await asA({ method: 'GET', url: '/api/suggestions?status=pending' });
    expect(r.statusCode).toBe(200);
    const names = (r.json().suggestions as Array<{ suggested_name: string }>).map(
      (s) => s.suggested_name,
    );
    expect(names).toEqual(['A-Suggestion']);
  });

  it("POST /api/suggestions/:id/approve 404s a cross-tenant suggestion", async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO category_suggestions (tenant_id, suggested_name)
       VALUES ($1, 'B-Sug') RETURNING id`,
      [B.id],
    );
    const approve = await asA({
      method: 'POST',
      url: `/api/suggestions/${r.rows[0]!.id}/approve`,
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(approve.statusCode).toBe(404);
  });

  it("POST /api/suggestions/:id/reject only clears caller-tenant transactions", async () => {
    // Both tenants have a transaction tagged with the same
    // suggested_category_name. Rejecting on Tenant A must NOT clear
    // the tag on Tenant B's row (pre-fix this UPDATE was global).
    const aAcct = await seedAccountFor(A.id, 'A');
    const bAcct = await seedAccountFor(B.id, 'B');
    const sugName = 'SharedSuggestion';
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash,
          suggested_category_name, normalization_status)
       VALUES ($1, '2026-05-01', -100, 'A', $3, $5, 'normalized'),
              ($2, '2026-05-01', -100, 'B', $4, $5, 'normalized')`,
      [aAcct, bAcct, randomUUID(), randomUUID(), sugName],
    );
    // Create matching suggestion rows for BOTH tenants.
    const aSug = await pool.query<{ id: string }>(
      `INSERT INTO category_suggestions (tenant_id, suggested_name)
       VALUES ($1, $2) RETURNING id`,
      [A.id, sugName],
    );
    const r = await asA({
      method: 'POST',
      url: `/api/suggestions/${aSug.rows[0]!.id}/reject`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().transactionsCleared).toBe(1);
    // A's tag cleared, B's preserved.
    const remaining = await pool.query<{ account_id: string; suggested_category_name: string | null }>(
      `SELECT account_id, suggested_category_name FROM transactions
        WHERE account_id IN ($1, $2) ORDER BY account_id`,
      [aAcct, bAcct],
    );
    const byAcct = new Map(
      remaining.rows.map((row) => [row.account_id, row.suggested_category_name]),
    );
    expect(byAcct.get(aAcct)).toBeNull();
    expect(byAcct.get(bAcct)).toBe(sugName);
  });

  // ── Tenants member-list (0.14.3 admin tighten) ──────────────

  it('GET /api/tenants/:id/members is now admin-only', async () => {
    // Tenant A admin (A.cookie) gets in. A child of Tenant B does NOT.
    const childUser = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash)
       VALUES ('child-b@local', 'Child', 'x') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'child')`,
      [B.id, childUser.rows[0]!.id],
    );
    const childSession = `iso-test-child-${childUser.rows[0]!.id.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at, active_tenant_id)
       VALUES ($1, $2, now() + interval '1 day', $3)`,
      [childSession, childUser.rows[0]!.id, B.id],
    );
    const childCookie = `smrtcash_session=${app.signCookie(childSession)}`;

    const childResp = await (app as unknown as { inject: (o: { method: string; url: string; headers: { cookie: string }; skipAuth?: boolean }) => Promise<{ statusCode: number }> }).inject({
      method: 'GET',
      url: `/api/tenants/${B.id}/members`,
      headers: { cookie: childCookie },
      skipAuth: true,
    });
    expect(childResp.statusCode).toBe(403);

    // Admin succeeds.
    const adminResp = await asA({
      method: 'GET',
      url: `/api/tenants/${A.id}/members`,
    });
    expect(adminResp.statusCode).toBe(200);
  });

  // ── Vehicles + commute-routes (0.14.4) ──────────────────────

  it('GET /api/vehicles returns only caller-tenant rows', async () => {
    await pool.query(
      `INSERT INTO vehicles (tenant_id, name, fuel_type, mpg, weekly_avg_miles)
       VALUES ($1, 'A-Car', 'regular', 25, 200),
              ($2, 'B-Car', 'regular', 30, 100)`,
      [A.id, B.id],
    );
    const r = await asA({ method: 'GET', url: '/api/vehicles' });
    expect(r.statusCode).toBe(200);
    const names = (r.json().vehicles as Array<{ name: string }>).map((v) => v.name);
    expect(names).toEqual(['A-Car']);
  });

  it('PATCH/DELETE /api/vehicles/:id 404 a cross-tenant vehicle', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO vehicles (tenant_id, name, fuel_type, mpg, weekly_avg_miles)
       VALUES ($1, 'B-Car', 'regular', 30, 100) RETURNING id`,
      [B.id],
    );
    const id = r.rows[0]!.id;
    const patch = await asA({
      method: 'PATCH',
      url: `/api/vehicles/${id}`,
      payload: { name: 'HACKED' },
      headers: { 'content-type': 'application/json' },
    });
    expect(patch.statusCode).toBe(404);
    const del = await asA({ method: 'DELETE', url: `/api/vehicles/${id}` });
    expect(del.statusCode).toBe(404);
    const still = await pool.query<{ name: string }>(
      `SELECT name FROM vehicles WHERE id = $1`,
      [id],
    );
    expect(still.rows[0]!.name).toBe('B-Car');
  });

  it("POST /api/commute-routes rejects a cross-tenant vehicleId in assignments", async () => {
    const bVehicle = await pool.query<{ id: string }>(
      `INSERT INTO vehicles (tenant_id, name, fuel_type, mpg, weekly_avg_miles)
       VALUES ($1, 'B-Car', 'regular', 30, 100) RETURNING id`,
      [B.id],
    );
    const r = await asA({
      method: 'POST',
      url: '/api/commute-routes',
      payload: {
        name: 'A-Route',
        distanceMiles: 20,
        assignments: [
          { vehicleId: bVehicle.rows[0]!.id, crossingsPerWeek: 5 },
        ],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
    // No route row created.
    const routes = await pool.query<{ id: string }>(
      `SELECT id FROM commute_routes WHERE tenant_id = $1`,
      [A.id],
    );
    expect(routes.rowCount).toBe(0);
  });

  it('PUT /api/commute-routes/:id/assignments 404 a cross-tenant route', async () => {
    const bRoute = await pool.query<{ id: string }>(
      `INSERT INTO commute_routes (tenant_id, name, distance_miles)
       VALUES ($1, 'B-Route', 10) RETURNING id`,
      [B.id],
    );
    const r = await asA({
      method: 'PUT',
      url: `/api/commute-routes/${bRoute.rows[0]!.id}/assignments`,
      payload: { assignments: [] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
  });

  // ── Normalize (0.14.4) ──────────────────────────────────────

  it('POST /api/normalize never touches cross-tenant pending transactions', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    await pool.query(
      `INSERT INTO transactions
         (account_id, txn_date, amount_cents, raw_description, dedup_hash,
          normalization_status)
       VALUES ($1, '2026-05-01', -1000, 'B-PURCHASE', $2, 'pending')`,
      [bAcct, randomUUID()],
    );
    const r = await asA({
      method: 'POST',
      url: '/api/normalize',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    // Pending count for A is 0 → processed 0.
    expect(r.json().summary.processed).toBe(0);
    // B's row still pending.
    const still = await pool.query<{ normalization_status: string }>(
      `SELECT normalization_status FROM transactions
        WHERE raw_description = 'B-PURCHASE'`,
    );
    expect(still.rows[0]!.normalization_status).toBe('pending');
  });

  it('POST /api/normalize 404s a cross-tenant accountId', async () => {
    const bAcct = await seedAccountFor(B.id, 'B');
    const r = await asA({
      method: 'POST',
      url: '/api/normalize',
      payload: { accountId: bAcct },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
  });

  // ── Projections NULL-hatch (0.14.4) ─────────────────────────

  it('PATCH /api/projections/:id 404s a NULL-tenant template (no mutation)', async () => {
    const tpl = await pool.query<{ id: string }>(
      `INSERT INTO retirement_projections
         (tenant_id, name, starting_balance_cents, monthly_contribution_cents,
          annual_return_pct, annual_inflation_pct, horizon_years)
       VALUES (NULL, 'Shared Template', 100000, 5000, 7, 2, 30) RETURNING id`,
    );
    const r = await asA({
      method: 'PATCH',
      url: `/api/projections/${tpl.rows[0]!.id}`,
      payload: { name: 'Hacked Template' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
    const after = await pool.query<{ name: string }>(
      `SELECT name FROM retirement_projections WHERE id = $1`,
      [tpl.rows[0]!.id],
    );
    expect(after.rows[0]!.name).toBe('Shared Template');
  });

  it('DELETE /api/projections/:id 404s a NULL-tenant template (no deletion)', async () => {
    const tpl = await pool.query<{ id: string }>(
      `INSERT INTO retirement_projections
         (tenant_id, name, starting_balance_cents, monthly_contribution_cents,
          annual_return_pct, annual_inflation_pct, horizon_years)
       VALUES (NULL, 'Keep Me', 100000, 5000, 7, 2, 30) RETURNING id`,
    );
    const r = await asA({
      method: 'DELETE',
      url: `/api/projections/${tpl.rows[0]!.id}`,
    });
    expect(r.statusCode).toBe(404);
    const still = await pool.query(
      `SELECT 1 FROM retirement_projections WHERE id = $1`,
      [tpl.rows[0]!.id],
    );
    expect(still.rowCount).toBe(1);
  });

  it('GET /api/projections still shows NULL-tenant templates (read OK)', async () => {
    await pool.query(
      `INSERT INTO retirement_projections
         (tenant_id, name, starting_balance_cents, monthly_contribution_cents,
          annual_return_pct, annual_inflation_pct, horizon_years)
       VALUES (NULL, 'Shared Template', 100000, 5000, 7, 2, 30)`,
    );
    const r = await asA({ method: 'GET', url: '/api/projections' });
    expect(r.statusCode).toBe(200);
    const names = (r.json().projections as Array<{ name: string }>).map(
      (p) => p.name,
    );
    expect(names).toContain('Shared Template');
  });

  it('POST /api/holdings/refresh-prices/crypto never touches other tenants', async () => {
    const aAcct = await seedAccountFor(A.id, 'A-Inv', 'investment');
    const bAcct = await seedAccountFor(B.id, 'B-Inv', 'investment');
    // A has BTC, B has ETH — refresh as A should NOT update B.
    await pool.query(
      `INSERT INTO holdings (tenant_id, account_id, symbol, name, asset_type, quantity, last_price_cents)
       VALUES ($1, $2, 'BTC', 'Bitcoin', 'crypto', 1, 0)`,
      [A.id, aAcct],
    );
    await pool.query(
      `INSERT INTO holdings (tenant_id, account_id, symbol, name, asset_type, quantity, last_price_cents)
       VALUES ($1, $2, 'ETH', 'Ethereum', 'crypto', 1, 0)`,
      [B.id, bAcct],
    );
    (app as unknown as { cryptoFetchOverride?: typeof fetch }).cryptoFetchOverride =
      (async () =>
        new Response(JSON.stringify({ bitcoin: { usd: 70000 }, ethereum: { usd: 3500 } }), {
          status: 200,
        })) as unknown as typeof fetch;
    const r = await asA({
      method: 'POST',
      url: '/api/holdings/refresh-prices/crypto',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().updated).toBe(1);
    const eth = await pool.query<{ last_price_cents: number }>(
      `SELECT last_price_cents FROM holdings
        WHERE tenant_id = $1 AND symbol = 'ETH'`,
      [B.id],
    );
    // B's ETH is untouched (still 0).
    expect(Number(eth.rows[0]!.last_price_cents)).toBe(0);
    (app as unknown as { cryptoFetchOverride?: typeof fetch }).cryptoFetchOverride =
      undefined;
  });
});
