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
