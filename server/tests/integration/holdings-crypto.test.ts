import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';

/**
 * 0.13.3 — crypto support on holdings + refresh-prices route.
 */

async function tenantId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
  );
  return r.rows[0]!.id;
}

function fakePriceFetch(
  body: Record<string, { usd: number }>,
  status = 200,
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('Holdings crypto support (0.13.3)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    (app as unknown as { cryptoFetchOverride?: typeof fetch }).cryptoFetchOverride =
      undefined;
  });

  it('defaults asset_type=stock when not provided on POST', async () => {
    const accountId = await seedAccount({ type: 'investment' });
    const r = await app.inject({
      method: 'POST',
      url: '/api/holdings',
      payload: {
        accountId,
        name: 'Apple',
        symbol: 'AAPL',
        quantity: 10,
        costBasisCents: 100_000,
        lastPriceCents: 15_000,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().holding.asset_type).toBe('stock');
  });

  it('accepts asset_type=crypto and rejects junk values', async () => {
    const accountId = await seedAccount({ type: 'investment' });
    const good = await app.inject({
      method: 'POST',
      url: '/api/holdings',
      payload: {
        accountId,
        name: 'Bitcoin',
        symbol: 'BTC',
        assetType: 'crypto',
        quantity: 0.5,
        costBasisCents: 2_500_000,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(good.statusCode).toBe(201);
    expect(good.json().holding.asset_type).toBe('crypto');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/holdings',
      payload: {
        accountId,
        name: 'Whatever',
        assetType: 'nft',
        quantity: 1,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('refresh-prices/crypto updates only crypto rows + records date', async () => {
    const accountId = await seedAccount({ type: 'investment' });
    // Stock — must NOT be touched.
    await pool.query(
      `INSERT INTO holdings (account_id, symbol, name, asset_type, quantity, last_price_cents)
       VALUES ($1, 'AAPL', 'Apple', 'stock', 10, 15000)`,
      [accountId],
    );
    // Crypto rows.
    await pool.query(
      `INSERT INTO holdings (account_id, symbol, name, asset_type, quantity, last_price_cents)
       VALUES ($1, 'BTC', 'Bitcoin', 'crypto', 0.5, 0),
              ($1, 'ETH', 'Ethereum', 'crypto', 2, 0)`,
      [accountId],
    );

    (app as unknown as { cryptoFetchOverride?: typeof fetch }).cryptoFetchOverride =
      fakePriceFetch({
        bitcoin: { usd: 70_000 },
        ethereum: { usd: 3_500 },
      });

    const r = await app.inject({
      method: 'POST',
      url: '/api/holdings/refresh-prices/crypto',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().updated).toBe(2);

    const after = await pool.query<{
      symbol: string;
      last_price_cents: number;
      last_price_date: string | null;
    }>(
      `SELECT symbol, last_price_cents, last_price_date::text AS last_price_date
         FROM holdings WHERE account_id = $1 ORDER BY symbol`,
      [accountId],
    );
    const bySymbol = new Map(after.rows.map((r) => [r.symbol, r]));
    expect(Number(bySymbol.get('BTC')!.last_price_cents)).toBe(7_000_000);
    expect(Number(bySymbol.get('ETH')!.last_price_cents)).toBe(350_000);
    // Stock must not have been touched.
    expect(Number(bySymbol.get('AAPL')!.last_price_cents)).toBe(15000);
    // Date stamped on the crypto rows.
    expect(bySymbol.get('BTC')!.last_price_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns unknown symbols separately', async () => {
    const accountId = await seedAccount({ type: 'investment' });
    await pool.query(
      `INSERT INTO holdings (account_id, symbol, name, asset_type, quantity, last_price_cents)
       VALUES ($1, 'ZZZ', 'Unknown', 'crypto', 1, 0),
              ($1, 'BTC', 'Bitcoin', 'crypto', 0.1, 0)`,
      [accountId],
    );
    (app as unknown as { cryptoFetchOverride?: typeof fetch }).cryptoFetchOverride =
      fakePriceFetch({ bitcoin: { usd: 60_000 } });
    const r = await app.inject({
      method: 'POST',
      url: '/api/holdings/refresh-prices/crypto',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().updated).toBe(1);
    expect(r.json().unknown).toContain('ZZZ');
  });

  it('refuses to run when CRYPTO_PRICE_PROVIDER=manual', async () => {
    const { setDbValue } = await import('../../src/domain/settings.js');
    await setDbValue('CRYPTO_PRICE_PROVIDER', 'manual');
    const accountId = await seedAccount({ type: 'investment' });
    await pool.query(
      `INSERT INTO holdings (account_id, symbol, name, asset_type, quantity)
       VALUES ($1, 'BTC', 'Bitcoin', 'crypto', 1)`,
      [accountId],
    );
    const r = await app.inject({
      method: 'POST',
      url: '/api/holdings/refresh-prices/crypto',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/manual/);
  });

  it('returns 0-updated when no crypto holdings exist', async () => {
    await seedAccount({ type: 'investment' });
    const r = await app.inject({
      method: 'POST',
      url: '/api/holdings/refresh-prices/crypto',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().updated).toBe(0);
  });

  it('tenant isolation — other tenant\'s crypto is invisible', async () => {
    const tid = await tenantId();
    const ours = await seedAccount({ type: 'investment' });
    await pool.query(
      `INSERT INTO holdings (account_id, symbol, name, asset_type, quantity)
       VALUES ($1, 'BTC', 'Bitcoin', 'crypto', 0.1)`,
      [ours],
    );
    // Different tenant.
    const other = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Other', 'other') RETURNING id`,
    );
    const otherAcct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (tenant_id, name, type, institution)
       VALUES ($1, 'Other', 'investment', 'X') RETURNING id`,
      [other.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO holdings (tenant_id, account_id, symbol, name, asset_type, quantity)
       VALUES ($1, $2, 'ETH', 'Ethereum', 'crypto', 5)`,
      [other.rows[0]!.id, otherAcct.rows[0]!.id],
    );

    (app as unknown as { cryptoFetchOverride?: typeof fetch }).cryptoFetchOverride =
      fakePriceFetch({
        bitcoin: { usd: 60_000 },
        ethereum: { usd: 3_000 },
      });
    const r = await app.inject({
      method: 'POST',
      url: '/api/holdings/refresh-prices/crypto',
    });
    expect(r.statusCode).toBe(200);
    // Default tenant has only BTC; ETH belongs to other tenant.
    expect(r.json().updated).toBe(1);
    // Symbols list should not include ETH.
    expect(r.json().symbols).toEqual(['BTC']);
    expect(tid).toBeTruthy();
  });
});
