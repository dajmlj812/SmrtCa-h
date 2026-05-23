import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';
import { setDbValue } from '../../src/domain/settings.js';

/**
 * Phase 8.2 — Plaid integration (0.11.2).
 *
 * Plaid is OFF by default. Every test that exercises a real Plaid
 * code path first enables it via app_settings + injects a mocked
 * fetch into the app instance so no live API calls happen.
 */

function fakeRespondingFetch(
  table: Record<string, (body: Record<string, unknown>) => { status?: number; body: unknown }>,
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const handler = table[path];
    if (!handler) {
      return new Response(JSON.stringify({ error_message: `unmapped ${path}` }), {
        status: 404,
      });
    }
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    const r = handler(body);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

async function enablePlaid() {
  await setDbValue('PLAID_ENABLED', 'true');
  await setDbValue('PLAID_CLIENT_ID', 'test_client');
  await setDbValue('PLAID_SECRET', 'test_secret');
  await setDbValue('PLAID_ENV', 'sandbox');
}

describe('Plaid routes (0.11.2)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    (app as unknown as { plaidFetchOverride?: typeof fetch }).plaidFetchOverride =
      undefined;
  });

  it('status reports enabled=false when Plaid is not configured', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/plaid/status' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ enabled: false, environment: null });
  });

  it('status reports enabled=true once PLAID_* settings are populated', async () => {
    await enablePlaid();
    const r = await app.inject({ method: 'GET', url: '/api/plaid/status' });
    expect(r.json()).toEqual({ enabled: true, environment: 'sandbox' });
  });

  it('link-token returns 400 when Plaid is disabled', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/plaid/link-token' });
    expect(r.statusCode).toBe(400);
  });

  it('link-token returns the token from Plaid when enabled', async () => {
    await enablePlaid();
    (app as unknown as { plaidFetchOverride?: typeof fetch }).plaidFetchOverride =
      fakeRespondingFetch({
        '/link/token/create': () => ({
          body: { link_token: 'link-sandbox-abc123', expiration: '2026-05-23T13:00:00Z' },
        }),
      });
    const r = await app.inject({ method: 'POST', url: '/api/plaid/link-token' });
    expect(r.statusCode).toBe(200);
    expect(r.json().link_token).toBe('link-sandbox-abc123');
  });

  it('exchange stores an encrypted access_token and lists accounts', async () => {
    await enablePlaid();
    (app as unknown as { plaidFetchOverride?: typeof fetch }).plaidFetchOverride =
      fakeRespondingFetch({
        '/item/public_token/exchange': () => ({
          body: { access_token: 'access-sandbox-super-secret', item_id: 'item-XYZ' },
        }),
        '/accounts/get': () => ({
          body: {
            accounts: [
              {
                account_id: 'plaid-acct-1',
                name: 'Checking',
                official_name: null,
                type: 'depository',
                subtype: 'checking',
                mask: '1234',
                balances: { available: 1000, current: 1000, iso_currency_code: 'USD' },
              },
            ],
            item: { item_id: 'item-XYZ', institution_id: 'ins_1' },
          },
        }),
      });
    const r = await app.inject({
      method: 'POST',
      url: '/api/plaid/exchange',
      payload: { publicToken: 'public-sandbox-9' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().item.plaid_item_id).toBe('item-XYZ');
    expect(r.json().accounts).toHaveLength(1);

    // Encrypted at rest — DB column doesn't contain plaintext token.
    const row = await pool.query<{ access_token_encrypted: Buffer }>(
      `SELECT access_token_encrypted FROM plaid_items WHERE plaid_item_id = $1`,
      ['item-XYZ'],
    );
    expect(row.rows[0]!.access_token_encrypted.toString('utf-8')).not.toContain(
      'access-sandbox-super-secret',
    );
  });

  it('link-account maps Plaid accounts to SmrtCash accounts', async () => {
    await enablePlaid();
    const accountId = await seedAccount();
    (app as unknown as { plaidFetchOverride?: typeof fetch }).plaidFetchOverride =
      fakeRespondingFetch({
        '/item/public_token/exchange': () => ({
          body: { access_token: 't', item_id: 'item-A' },
        }),
        '/accounts/get': () => ({
          body: { accounts: [], item: { item_id: 'item-A', institution_id: null } },
        }),
      });
    const created = await app.inject({
      method: 'POST',
      url: '/api/plaid/exchange',
      payload: { publicToken: 'p' },
      headers: { 'content-type': 'application/json' },
    });
    const itemRowId = created.json().item.id as string;

    const link = await app.inject({
      method: 'POST',
      url: `/api/plaid/items/${itemRowId}/link-account`,
      payload: {
        links: [
          {
            plaidAccountId: 'plaid-acct-1',
            accountId,
            plaidAccountName: 'Checking',
            plaidAccountMask: '1234',
          },
        ],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(link.statusCode).toBe(200);
    expect(link.json()).toMatchObject({ ok: true, linkedCount: 1 });
  });

  it('sync persists transactions into the mapped SmrtCash account and advances cursor', async () => {
    await enablePlaid();
    const accountId = await seedAccount();
    (app as unknown as { plaidFetchOverride?: typeof fetch }).plaidFetchOverride =
      fakeRespondingFetch({
        '/item/public_token/exchange': () => ({
          body: { access_token: 't', item_id: 'item-S' },
        }),
        '/accounts/get': () => ({
          body: { accounts: [], item: { item_id: 'item-S', institution_id: null } },
        }),
        '/transactions/sync': () => ({
          body: {
            added: [
              {
                transaction_id: 'p-txn-1',
                account_id: 'plaid-acct-1',
                date: '2026-03-15',
                authorized_date: '2026-03-14',
                amount: 12.34,
                iso_currency_code: 'USD',
                name: 'Coffee Shop',
                merchant_name: 'Starbucks',
                category: ['Food and Drink'],
                pending: false,
                payment_channel: 'in_store',
                transaction_type: 'place',
              },
            ],
            modified: [],
            removed: [],
            next_cursor: 'cursor-after-1',
            has_more: false,
            request_id: 'r',
          },
        }),
      });

    const created = await app.inject({
      method: 'POST',
      url: '/api/plaid/exchange',
      payload: { publicToken: 'p' },
      headers: { 'content-type': 'application/json' },
    });
    const itemRowId = created.json().item.id as string;

    await app.inject({
      method: 'POST',
      url: `/api/plaid/items/${itemRowId}/link-account`,
      payload: {
        links: [{ plaidAccountId: 'plaid-acct-1', accountId }],
      },
      headers: { 'content-type': 'application/json' },
    });

    const sync = await app.inject({
      method: 'POST',
      url: `/api/plaid/items/${itemRowId}/sync`,
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({
      ok: true,
      importedCount: 1,
      skippedCount: 0,
    });

    const txn = await pool.query<{ amount_cents: number; raw_description: string }>(
      `SELECT amount_cents, raw_description FROM transactions WHERE account_id = $1`,
      [accountId],
    );
    expect(txn.rowCount).toBe(1);
    // Plaid 12.34 outflow -> -1234 cents in SmrtCash sign convention.
    expect(txn.rows[0]!.amount_cents).toBe(-1234);
    expect(txn.rows[0]!.raw_description).toBe('Starbucks');

    // Cursor advanced + status flipped to ok.
    const after = await pool.query<{
      sync_cursor: string;
      last_sync_status: string;
      last_sync_imported: number;
    }>(
      `SELECT sync_cursor, last_sync_status, last_sync_imported FROM plaid_items WHERE id = $1`,
      [itemRowId],
    );
    expect(after.rows[0]!.sync_cursor).toBe('cursor-after-1');
    expect(after.rows[0]!.last_sync_status).toBe('ok');
    expect(after.rows[0]!.last_sync_imported).toBe(1);
  });

  it('sync records auth_failed and surfaces it to the caller', async () => {
    await enablePlaid();
    const accountId = await seedAccount();
    (app as unknown as { plaidFetchOverride?: typeof fetch }).plaidFetchOverride =
      fakeRespondingFetch({
        '/item/public_token/exchange': () => ({
          body: { access_token: 't', item_id: 'item-F' },
        }),
        '/accounts/get': () => ({
          body: { accounts: [], item: { item_id: 'item-F', institution_id: null } },
        }),
        '/transactions/sync': () => ({
          status: 400,
          body: {
            error_code: 'ITEM_LOGIN_REQUIRED',
            error_type: 'ITEM_ERROR',
            error_message: 'Re-authenticate the user',
          },
        }),
      });

    const created = await app.inject({
      method: 'POST',
      url: '/api/plaid/exchange',
      payload: { publicToken: 'p' },
      headers: { 'content-type': 'application/json' },
    });
    const itemRowId = created.json().item.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/plaid/items/${itemRowId}/link-account`,
      payload: { links: [{ plaidAccountId: 'plaid-acct-1', accountId }] },
      headers: { 'content-type': 'application/json' },
    });

    const sync = await app.inject({
      method: 'POST',
      url: `/api/plaid/items/${itemRowId}/sync`,
    });
    expect(sync.statusCode).toBe(400);
    expect(sync.json()).toMatchObject({ ok: false, kind: 'auth_failed' });

    const after = await pool.query<{ last_sync_status: string; last_sync_error: string }>(
      `SELECT last_sync_status, last_sync_error FROM plaid_items WHERE id = $1`,
      [itemRowId],
    );
    expect(after.rows[0]!.last_sync_status).toBe('auth_failed');
    expect(after.rows[0]!.last_sync_error).toContain('Re-authenticate');
  });

  it('DELETE calls /item/remove (best-effort) and removes the row', async () => {
    await enablePlaid();
    let removeCalled = false;
    (app as unknown as { plaidFetchOverride?: typeof fetch }).plaidFetchOverride =
      fakeRespondingFetch({
        '/item/public_token/exchange': () => ({
          body: { access_token: 't', item_id: 'item-D' },
        }),
        '/accounts/get': () => ({
          body: { accounts: [], item: { item_id: 'item-D', institution_id: null } },
        }),
        '/item/remove': () => {
          removeCalled = true;
          return { body: { request_id: 'r' } };
        },
      });
    const created = await app.inject({
      method: 'POST',
      url: '/api/plaid/exchange',
      payload: { publicToken: 'p' },
      headers: { 'content-type': 'application/json' },
    });
    const itemRowId = created.json().item.id as string;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/plaid/items/${itemRowId}`,
    });
    expect(del.statusCode).toBe(204);
    expect(removeCalled).toBe(true);

    const remaining = await pool.query(`SELECT id FROM plaid_items WHERE id = $1`, [
      itemRowId,
    ]);
    expect(remaining.rowCount).toBe(0);
  });
});
