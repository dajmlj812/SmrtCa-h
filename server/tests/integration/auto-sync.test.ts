import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  makeSuperAdminCookie,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';
import { runAutoSyncTick } from '../../src/domain/auto-sync.js';
import { setDbValue } from '../../src/domain/settings.js';
import { encryptString } from '../../src/domain/crypto.js';

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
  });
});
