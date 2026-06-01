import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  makeSuperAdminCookie,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';
import { runAutoSyncTick as runAutoSyncTickRaw } from '../../src/domain/auto-sync.js';
import { setDbValue } from '../../src/domain/settings.js';
import { encryptString } from '../../src/domain/crypto.js';

// The real OFX fetch-time SSRF guard resolves DNS, which fails for the
// synthetic `example.bank` host these tests seed. Inject a no-op guard
// into every tick so OFX sync runs offline; production still resolves
// and validates real bank URLs. Per-test ofxFetchOverride etc. pass
// through unchanged.
type AutoSyncOpts = Parameters<typeof runAutoSyncTickRaw>[0];
const runAutoSyncTick = (opts: AutoSyncOpts = {}) =>
  runAutoSyncTickRaw({ ofxSafetyOverride: async () => {}, ...opts });

/**
 * Phase 8.3 — Auto-sync scheduler (0.11.3) end-to-end.
 *
 * Drives `runAutoSyncTick` directly with mocked fetches for both
 * OFX-DC and Plaid. Verifies that:
 *   - sources due for sync get fired
 *   - sources not yet due are skipped
 *   - per-source failures don't block siblings
 *   - last_sync_* columns advance for successes and failures alike
 */

const OFX_OK = [
  'OFXHEADER:100',
  'DATA:OFXSGML',
  'VERSION:102',
  '',
  '',
  '<OFX>',
  '<SIGNONMSGSRSV1>',
  '<SONRS>',
  '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
  '<DTSERVER>20260523000000',
  '<LANGUAGE>ENG',
  '</SONRS>',
  '</SIGNONMSGSRSV1>',
  '<BANKMSGSRSV1>',
  '<STMTTRNRS>',
  '<TRNUID>X',
  '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
  '<STMTRS>',
  '<CURDEF>USD',
  '<BANKACCTFROM>',
  '<BANKID>021000021',
  '<ACCTID>1234',
  '<ACCTTYPE>CHECKING',
  '</BANKACCTFROM>',
  '<BANKTRANLIST>',
  '<DTSTART>20260501',
  '<DTEND>20260523',
  '<STMTTRN>',
  '<TRNTYPE>DEBIT',
  '<DTPOSTED>20260510',
  '<TRNAMT>-7.77',
  '<FITID>auto-1',
  '<NAME>Auto Sync OFX',
  '</STMTTRN>',
  '</BANKTRANLIST>',
  '</STMTRS>',
  '</STMTTRNRS>',
  '</BANKMSGSRSV1>',
  '</OFX>',
].join('\r\n');

const OFX_AUTH_FAIL = [
  'OFXHEADER:100',
  'DATA:OFXSGML',
  'VERSION:102',
  '',
  '',
  '<OFX>',
  '<SIGNONMSGSRSV1>',
  '<SONRS>',
  '<STATUS><CODE>15500<SEVERITY>ERROR<MESSAGE>Invalid signon</STATUS>',
  '<DTSERVER>20260523000000',
  '<LANGUAGE>ENG',
  '</SONRS>',
  '</SIGNONMSGSRSV1>',
  '</OFX>',
].join('\r\n');

function ofxFetch(body: string): typeof fetch {
  return (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

async function enableAutoSync() {
  await setDbValue('AUTO_SYNC_ENABLED', 'true');
  await setDbValue('AUTO_SYNC_FREQUENCY', 'hourly');
}

async function enablePlaid() {
  await setDbValue('PLAID_ENABLED', 'true');
  await setDbValue('PLAID_CLIENT_ID', 'test_client');
  await setDbValue('PLAID_SECRET', 'test_secret');
  await setDbValue('PLAID_ENV', 'sandbox');
}

async function seedOfxDcConnection(accountId: string): Promise<string> {
  // Need an active tenant id — use the seeded Default tenant.
  const t = await pool.query<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
  const tenantId = t.rows[0]!.id;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO ofx_dc_connections
       (tenant_id, account_id, name, ofx_url, ofx_org, ofx_fid, ofx_app_id,
        ofx_app_version, username_encrypted, password_encrypted,
        bank_acct_id, bank_acct_type, bank_id, enabled)
     VALUES ($1,$2,'Auto Bank','https://x.bank/ofx','ExampleBank','1001','QWIN',
             '2700',$3,$4,'1234','CHECKING','021000021', true)
     RETURNING id`,
    [tenantId, accountId, encryptString('u'), encryptString('p')],
  );
  return r.rows[0]!.id;
}

async function seedPlaidItem(accountId: string): Promise<string> {
  const t = await pool.query<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
  const tenantId = t.rows[0]!.id;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO plaid_items
       (tenant_id, plaid_item_id, access_token_encrypted)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, `auto-${Date.now()}`, encryptString('access-test')],
  );
  const itemId = r.rows[0]!.id;
  await pool.query(
    `INSERT INTO plaid_account_links
       (plaid_item_id, plaid_account_id, account_id)
     VALUES ($1, 'plaid-auto-1', $2)`,
    [itemId, accountId],
  );
  return itemId;
}

function plaidFetch(
  resp: (path: string, body: Record<string, unknown>) => { status?: number; body: unknown },
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const r = resp(path, body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe('Auto-sync scheduler (0.11.3)', () => {
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

  it('no-op when disabled', async () => {
    const accountId = await seedAccount();
    await seedOfxDcConnection(accountId);
    const r = await runAutoSyncTick({});
    expect(r.enabled).toBe(false);
    expect(r.ofxDc.attempted).toBe(0);
  });

  it('force=true bypasses the enabled gate', async () => {
    const accountId = await seedAccount();
    await seedOfxDcConnection(accountId);
    const r = await runAutoSyncTick({
      force: true,
      ofxFetchOverride: ofxFetch(OFX_OK),
    });
    expect(r.ofxDc.attempted).toBe(1);
    expect(r.ofxDc.succeeded).toBe(1);
  });

  it('persists OFX-DC transactions and updates last_sync_status', async () => {
    await enableAutoSync();
    const accountId = await seedAccount();
    const id = await seedOfxDcConnection(accountId);
    const r = await runAutoSyncTick({
      ofxFetchOverride: ofxFetch(OFX_OK),
    });
    expect(r.ofxDc.succeeded).toBe(1);

    const txn = await pool.query<{ amount_cents: number }>(
      `SELECT amount_cents FROM transactions WHERE account_id = $1`,
      [accountId],
    );
    expect(txn.rowCount).toBe(1);
    expect(txn.rows[0]!.amount_cents).toBe(-777);

    const after = await pool.query<{ last_sync_status: string }>(
      `SELECT last_sync_status FROM ofx_dc_connections WHERE id = $1`,
      [id],
    );
    expect(after.rows[0]!.last_sync_status).toBe('ok');
  });

  it('per-source failures do not block siblings', async () => {
    await enableAutoSync();
    const acctA = await seedAccount({ name: 'A' });
    const acctB = await seedAccount({ name: 'B' });
    const idA = await seedOfxDcConnection(acctA);
    const idB = await seedOfxDcConnection(acctB);

    // First fetch fails auth, second succeeds. Order is by INSERT order
    // so idA is fetched first.
    let call = 0;
    const fetchSeq = (async () => {
      call += 1;
      return new Response(call === 1 ? OFX_AUTH_FAIL : OFX_OK, { status: 200 });
    }) as unknown as typeof fetch;

    const r = await runAutoSyncTick({ ofxFetchOverride: fetchSeq });
    expect(r.ofxDc.attempted).toBe(2);
    expect(r.ofxDc.succeeded).toBe(1);
    expect(r.ofxDc.failed).toBe(1);

    const rows = await pool.query<{ id: string; last_sync_status: string }>(
      `SELECT id, last_sync_status FROM ofx_dc_connections WHERE id IN ($1,$2)`,
      [idA, idB],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.last_sync_status]));
    expect(byId.get(idA)).toBe('auth_failed');
    expect(byId.get(idB)).toBe('ok');
  });

  it('skips a source whose last_sync_at is too recent for the cadence', async () => {
    await enableAutoSync();
    const accountId = await seedAccount();
    const id = await seedOfxDcConnection(accountId);
    // Mark this source as just-synced; hourly cadence => skip.
    await pool.query(
      `UPDATE ofx_dc_connections SET last_sync_at = now() WHERE id = $1`,
      [id],
    );
    const r = await runAutoSyncTick({
      ofxFetchOverride: ofxFetch(OFX_OK),
    });
    expect(r.ofxDc.attempted).toBe(0);
  });

  it('syncs Plaid items alongside OFX-DC in the same tick', async () => {
    await enableAutoSync();
    await enablePlaid();
    const acctOfx = await seedAccount({ name: 'OFX' });
    const acctPlaid = await seedAccount({ name: 'Plaid' });
    await seedOfxDcConnection(acctOfx);
    await seedPlaidItem(acctPlaid);

    const pFetch = plaidFetch((path) => {
      if (path === '/transactions/sync') {
        return {
          body: {
            added: [
              {
                transaction_id: 'pt1',
                account_id: 'plaid-auto-1',
                date: '2026-05-10',
                authorized_date: null,
                amount: 9.99,
                iso_currency_code: 'USD',
                name: 'Auto Plaid',
                merchant_name: null,
                category: null,
                pending: false,
                payment_channel: null,
                transaction_type: null,
              },
            ],
            modified: [],
            removed: [],
            next_cursor: 'after-1',
            has_more: false,
            request_id: 'r',
          },
        };
      }
      return { status: 404, body: { error_message: 'unmapped' } };
    });

    const r = await runAutoSyncTick({
      ofxFetchOverride: ofxFetch(OFX_OK),
      plaidFetchOverride: pFetch,
    });
    expect(r.ofxDc.succeeded).toBe(1);
    expect(r.plaid.succeeded).toBe(1);

    const ofxTxn = await pool.query(
      `SELECT id FROM transactions WHERE account_id = $1`,
      [acctOfx],
    );
    const plaidTxn = await pool.query(
      `SELECT id FROM transactions WHERE account_id = $1`,
      [acctPlaid],
    );
    expect(ofxTxn.rowCount).toBe(1);
    expect(plaidTxn.rowCount).toBe(1);
  });

  it('GET /api/auto-sync/status requires super admin and reports config', async () => {
    await enableAutoSync();
    const tenantR = await app.inject({
      method: 'GET',
      url: '/api/auto-sync/status',
    });
    expect(tenantR.statusCode).toBe(403);

    const cookie = await makeSuperAdminCookie(app);
    const superR = await app.inject({
      method: 'GET',
      url: '/api/auto-sync/status',
      headers: { cookie },
      skipAuth: true,
    });
    expect(superR.statusCode).toBe(200);
    expect(superR.json()).toMatchObject({
      enabled: true,
      frequency: 'hourly',
      sources: { ofx_dc: 0, plaid: 0 },
    });
  });

  it('POST /api/auto-sync/run forces a tick (super admin only)', async () => {
    const cookie = await makeSuperAdminCookie(app);
    const accountId = await seedAccount();
    await seedOfxDcConnection(accountId);

    // We can't inject the fetch through the HTTP layer here — but the
    // route gates super-admin only and returns a result shape. Verify
    // the gate + the shape.
    const r = await app.inject({
      method: 'POST',
      url: '/api/auto-sync/run',
      headers: { cookie },
      skipAuth: true,
    });
    // Real fetch will fail (no network in test) but the route still
    // returns a result object documenting the attempt.
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toHaveProperty('ofxDc');
    expect(body).toHaveProperty('plaid');
    expect(body).toHaveProperty('crypto');
  });

  // ── 0.13.5 — crypto-price refresh inside the tick ──────────
  describe('crypto price refresh (0.13.5)', () => {
    /** Build a CoinGecko-shaped JSON fetch. */
    function priceFetch(
      body: Record<string, { usd: number }>,
      status = 200,
    ): typeof fetch {
      return (async () =>
        new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    }

    /** Seed a crypto holding directly on an account. */
    async function seedCryptoHolding(
      accountId: string,
      symbol: string,
      opts: { lastPriceDate?: string | null } = {},
    ): Promise<string> {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO holdings
           (account_id, symbol, name, asset_type, quantity,
            last_price_cents, last_price_date)
         VALUES ($1, $2, $2, 'crypto', 1, 0, $3) RETURNING id`,
        [accountId, symbol, opts.lastPriceDate ?? null],
      );
      return r.rows[0]!.id;
    }

    it('prices crypto holdings and updates last_price_cents + date', async () => {
      const accountId = await seedAccount({ type: 'investment' });
      const btcId = await seedCryptoHolding(accountId, 'BTC');
      const ethId = await seedCryptoHolding(accountId, 'ETH');

      const r = await runAutoSyncTick({
        force: true,
        cryptoFetchOverride: priceFetch({
          bitcoin: { usd: 70_000 },
          ethereum: { usd: 3_500 },
        }),
      });
      expect(r.crypto.attempted).toBe(2);
      expect(r.crypto.updated).toBe(2);
      expect(r.crypto.failed).toBe(0);

      const after = await pool.query<{
        id: string;
        last_price_cents: number;
        last_price_date: string | null;
      }>(
        `SELECT id, last_price_cents, last_price_date::text AS last_price_date
           FROM holdings WHERE id = ANY($1::uuid[])`,
        [[btcId, ethId]],
      );
      const byId = new Map(after.rows.map((r) => [r.id, r]));
      expect(Number(byId.get(btcId)!.last_price_cents)).toBe(7_000_000);
      expect(Number(byId.get(ethId)!.last_price_cents)).toBe(350_000);
      expect(byId.get(btcId)!.last_price_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('counts unknown symbols separately from updates', async () => {
      const accountId = await seedAccount({ type: 'investment' });
      await seedCryptoHolding(accountId, 'BTC');
      await seedCryptoHolding(accountId, 'ZZZ');

      const r = await runAutoSyncTick({
        force: true,
        cryptoFetchOverride: priceFetch({ bitcoin: { usd: 60_000 } }),
      });
      expect(r.crypto.attempted).toBe(2);
      expect(r.crypto.updated).toBe(1);
      expect(r.crypto.unknown).toBe(1);
    });

    it('skips the provider call when CRYPTO_PRICE_PROVIDER=manual', async () => {
      await setDbValue('CRYPTO_PRICE_PROVIDER', 'manual');
      const accountId = await seedAccount({ type: 'investment' });
      await seedCryptoHolding(accountId, 'BTC');

      // A fetch that would throw if called — proves we never called it.
      const exploding = (() => {
        throw new Error('provider must not be called in manual mode');
      }) as unknown as typeof fetch;

      const r = await runAutoSyncTick({
        force: true,
        cryptoFetchOverride: exploding,
      });
      expect(r.crypto.attempted).toBe(0);
      expect(r.crypto.updated).toBe(0);
      expect(r.crypto.failed).toBe(0);
    });

    it('skips holdings already priced today (per-day cadence gate)', async () => {
      const accountId = await seedAccount({ type: 'investment' });
      const now = new Date('2026-05-23T14:00:00Z');
      const today = now.toISOString().slice(0, 10);
      // BTC already priced today → must NOT be re-fetched.
      await seedCryptoHolding(accountId, 'BTC', { lastPriceDate: today });
      // ETH never priced → must be fetched.
      await seedCryptoHolding(accountId, 'ETH');

      const seen: string[] = [];
      const recordingFetch = (async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ ethereum: { usd: 3_500 } }), {
          status: 200,
        });
      }) as unknown as typeof fetch;

      const r = await runAutoSyncTick({
        force: true,
        now,
        cryptoFetchOverride: recordingFetch,
      });
      expect(r.crypto.attempted).toBe(1);
      expect(r.crypto.updated).toBe(1);
      expect(seen).toHaveLength(1);
      // CoinGecko URL must include ethereum, must NOT include bitcoin.
      expect(seen[0]).toContain('ethereum');
      expect(seen[0]).not.toContain('bitcoin');
    });

    it('a tenant-level provider failure does not block sibling tenants', async () => {
      // Two tenants, each with one crypto holding. Tenant A's batch
      // 429s; tenant B's batch succeeds. Verify A is counted failed
      // and B is still updated.
      const acctA = await seedAccount({ name: 'A', type: 'investment' });
      const tB = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, slug) VALUES ('B', 'b') RETURNING id`,
      );
      const tenantBId = tB.rows[0]!.id;
      const acctBRes = await pool.query<{ id: string }>(
        `INSERT INTO accounts (tenant_id, name, type, institution)
           VALUES ($1, 'B-Acct', 'investment', 'X') RETURNING id`,
        [tenantBId],
      );
      const acctB = acctBRes.rows[0]!.id;
      await seedCryptoHolding(acctA, 'BTC');
      await seedCryptoHolding(acctB, 'ETH');

      let call = 0;
      const fetchSeq = (async (url: string) => {
        call += 1;
        // First batch (whichever tenant ran first) → 429.
        if (call === 1) {
          return new Response('rate limit', { status: 429 });
        }
        // Second batch → succeed with whichever coin was requested.
        const u = String(url);
        const body: Record<string, { usd: number }> = {};
        if (u.includes('bitcoin')) body.bitcoin = { usd: 60_000 };
        if (u.includes('ethereum')) body.ethereum = { usd: 3_000 };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch;

      const r = await runAutoSyncTick({
        force: true,
        cryptoFetchOverride: fetchSeq,
      });
      expect(r.crypto.attempted).toBe(2);
      expect(r.crypto.failed).toBe(1);
      expect(r.crypto.updated).toBe(1);
    });
  });
});
