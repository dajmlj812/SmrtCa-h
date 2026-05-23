import { describe, it, expect } from 'vitest';
import {
  coinIdFor,
  CryptoPriceError,
  fetchCryptoPrices,
  type FetchLike,
} from '../../src/domain/crypto-prices.js';

function fakeFetch(responder: (url: string) => { status?: number; body: unknown }): FetchLike {
  return (async (input: string | URL) => {
    const r = responder(String(input));
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as FetchLike;
}

describe('crypto-prices fetcher (0.13.3)', () => {
  it('coinIdFor maps known symbols and returns null for unknown', () => {
    expect(coinIdFor('BTC')).toBe('bitcoin');
    expect(coinIdFor('eth')).toBe('ethereum');
    expect(coinIdFor('  Sol ')).toBe('solana');
    expect(coinIdFor('ZZZ')).toBeNull();
  });

  it('returns USD-cents prices keyed by uppercase symbol', async () => {
    let capturedUrl = '';
    const r = await fetchCryptoPrices({
      symbols: ['btc', 'ETH'],
      fetchImpl: fakeFetch((url) => {
        capturedUrl = url;
        return { body: { bitcoin: { usd: 65432.1 }, ethereum: { usd: 3200 } } };
      }),
    });
    expect(capturedUrl).toContain('ids=bitcoin%2Cethereum');
    expect(r.prices.BTC).toBe(6_543_210);
    expect(r.prices.ETH).toBe(320_000);
    expect(r.unknown).toEqual([]);
  });

  it('partitions unknown symbols separately', async () => {
    const r = await fetchCryptoPrices({
      symbols: ['BTC', 'ZZZ', 'XYZ'],
      fetchImpl: fakeFetch(() => ({ body: { bitcoin: { usd: 50000 } } })),
    });
    expect(r.prices.BTC).toBe(5_000_000);
    expect(r.unknown).toEqual(['ZZZ', 'XYZ']);
  });

  it('skips the HTTP call when every symbol is unknown', async () => {
    let called = false;
    const r = await fetchCryptoPrices({
      symbols: ['ZZZ'],
      fetchImpl: fakeFetch(() => {
        called = true;
        return { body: {} };
      }),
    });
    expect(called).toBe(false);
    expect(r.unknown).toEqual(['ZZZ']);
    expect(r.prices).toEqual({});
  });

  it('throws rate_limited on HTTP 429', async () => {
    await expect(
      fetchCryptoPrices({
        symbols: ['btc'],
        fetchImpl: fakeFetch(() => ({ status: 429, body: {} })),
      }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('throws http_error on HTTP 500', async () => {
    await expect(
      fetchCryptoPrices({
        symbols: ['btc'],
        fetchImpl: fakeFetch(() => ({ status: 500, body: {} })),
      }),
    ).rejects.toMatchObject({ kind: 'http_error' });
  });

  it('throws transport_error on a network rejection', async () => {
    await expect(
      fetchCryptoPrices({
        symbols: ['btc'],
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as FetchLike,
      }),
    ).rejects.toBeInstanceOf(CryptoPriceError);
  });

  it('treats no-price-returned as unknown for that symbol', async () => {
    const r = await fetchCryptoPrices({
      symbols: ['btc', 'eth'],
      fetchImpl: fakeFetch(() => ({ body: { bitcoin: { usd: 50000 }, ethereum: {} } })),
    });
    expect(r.prices.BTC).toBe(5_000_000);
    expect(r.unknown).toContain('ETH');
  });
});
