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
