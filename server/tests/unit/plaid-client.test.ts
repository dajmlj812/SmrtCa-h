import { describe, it, expect } from 'vitest';
import {
  mapPlaidTransaction,
  PlaidClient,
  PlaidError,
  type FetchLike,
  type PlaidTxn,
} from '../../src/domain/plaid.js';

const CFG = {
  clientId: 'test_client',
  secret: 'test_secret',
  environment: 'sandbox' as const,
};

function fakeFetch(
  responder: (
    url: string,
    init: RequestInit,
  ) => { status?: number; body: unknown },
): FetchLike {
  return (async (input: string | URL, init?: RequestInit) => {
    const r = responder(String(input), init!);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as FetchLike;
}

describe('Plaid REST client (0.11.2)', () => {
  it('routes to the sandbox host', async () => {
    let observedUrl = '';
    const client = new PlaidClient({
      config: CFG,
      fetchImpl: fakeFetch((url) => {
        observedUrl = url;
        return { body: { link_token: 'tok', expiration: 'x' } };
      }),
    });
    await client.linkTokenCreate({ userId: 'u1', clientName: 'SmrtCash' });
    expect(observedUrl).toBe('https://sandbox.plaid.com/link/token/create');
  });

  it('sends client_id + secret + body params in the JSON body', async () => {
    let captured: Record<string, unknown> = {};
    const client = new PlaidClient({
      config: CFG,
      fetchImpl: fakeFetch((_url, init) => {
        captured = JSON.parse(init.body as string);
        return { body: { access_token: 'tok', item_id: 'item1' } };
      }),
    });
    await client.exchangePublicToken('public-1');
    expect(captured.client_id).toBe('test_client');
    expect(captured.secret).toBe('test_secret');
    expect(captured.public_token).toBe('public-1');
  });

  it('throws auth_failed on INVALID_CLIENT_ID', async () => {
    const client = new PlaidClient({
      config: CFG,
      fetchImpl: fakeFetch(() => ({
        status: 400,
        body: {
          error_code: 'INVALID_CLIENT_ID',
          error_type: 'INVALID_INPUT',
          error_message: 'No bueno',
        },
      })),
    });
    await expect(
      client.linkTokenCreate({ userId: 'u', clientName: 'X' }),
    ).rejects.toMatchObject({ kind: 'auth_failed', plaidErrorCode: 'INVALID_CLIENT_ID' });
  });

  it('throws rate_limited on HTTP 429', async () => {
    const client = new PlaidClient({
      config: CFG,
      fetchImpl: fakeFetch(() => ({ status: 429, body: { error_message: 'slow down' } })),
    });
    await expect(client.itemRemove('tok')).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });

  it('throws transport_error on a failed fetch', async () => {
    const client = new PlaidClient({
      config: CFG,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as FetchLike,
    });
    await expect(client.accountsGet('tok')).rejects.toBeInstanceOf(PlaidError);
  });

  it('transactions/sync passes cursor through', async () => {
    let captured: Record<string, unknown> = {};
    const client = new PlaidClient({
      config: CFG,
      fetchImpl: fakeFetch((_url, init) => {
        captured = JSON.parse(init.body as string);
        return {
          body: { added: [], modified: [], removed: [], next_cursor: 'c2', has_more: false, request_id: 'r' },
        };
      }),
    });
    await client.transactionsSync('tok', 'c1');
    expect(captured.cursor).toBe('c1');
    expect(captured.access_token).toBe('tok');
  });

  it('mapPlaidTransaction inverts the sign (Plaid + = outflow)', () => {
    const p: PlaidTxn = {
      transaction_id: 't1',
      account_id: 'a1',
      date: '2026-03-15',
      authorized_date: '2026-03-14',
      amount: 25.5,
      iso_currency_code: 'USD',
      name: 'Starbucks',
      merchant_name: 'Starbucks Coffee',
      category: ['Food and Drink', 'Coffee'],
      pending: false,
      payment_channel: 'in_store',
      transaction_type: 'place',
    };
    const m = mapPlaidTransaction(p);
    expect(m.amountCents).toBe(-2550);
    expect(m.txnDate).toBe('2026-03-15');
    expect(m.postDate).toBe('2026-03-14');
    expect(m.rawDescription).toBe('Starbucks Coffee');
    expect(m.sourceCategory).toBe('Food and Drink');
    expect(m.pending).toBe(false);
  });

  it('mapPlaidTransaction handles inflows (Plaid - = inflow) and falls back to name', () => {
    const p: PlaidTxn = {
      transaction_id: 't2',
      account_id: 'a1',
      date: '2026-03-15',
      authorized_date: null,
      amount: -1000,
      iso_currency_code: 'USD',
      name: 'Refund',
      merchant_name: null,
      category: null,
      pending: true,
      payment_channel: null,
      transaction_type: null,
    };
    const m = mapPlaidTransaction(p);
    expect(m.amountCents).toBe(100000);
    expect(m.postDate).toBe('2026-03-15');
    expect(m.rawDescription).toBe('Refund');
    expect(m.sourceCategory).toBeNull();
    expect(m.pending).toBe(true);
    expect(m.memo).toContain('pending');
  });
});
