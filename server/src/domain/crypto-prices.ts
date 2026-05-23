/**
 * Backlog (0.13.3) — crypto price fetcher.
 *
 * Talks to CoinGecko's free public API:
 *   https://api.coingecko.com/api/v3/simple/price?ids=...&vs_currencies=usd
 *
 * No API key. Rate limit is generous for a household app (~30 calls/min).
 * Symbols (BTC, ETH, etc.) are mapped to CoinGecko ids (bitcoin, ethereum).
 * Unknown symbols are reported in the result rather than throwing — a
 * batch refresh shouldn't fail because one obscure token isn't in our
 * table.
 */

export type FetchLike = typeof fetch;

export type CryptoFailureKind =
  | 'unknown_symbol'
  | 'http_error'
  | 'rate_limited'
  | 'transport_error';

export class CryptoPriceError extends Error {
  constructor(public readonly kind: CryptoFailureKind, message: string) {
    super(message);
    this.name = 'CryptoPriceError';
  }
}

/**
 * Lowercase symbol → CoinGecko coin id. Covers the assets a typical
 * household-finance user is likely to hold; everything else returns
 * an 'unknown_symbol' error and is skipped during refresh.
 *
 * To add a coin: look up the id at https://api.coingecko.com/api/v3/coins/list
 */
const SYMBOL_TO_COIN_ID: Record<string, string> = {
  btc: 'bitcoin',
  eth: 'ethereum',
  usdt: 'tether',
  usdc: 'usd-coin',
  bnb: 'binancecoin',
  xrp: 'ripple',
  sol: 'solana',
  ada: 'cardano',
  doge: 'dogecoin',
  trx: 'tron',
  ton: 'the-open-network',
  avax: 'avalanche-2',
  shib: 'shiba-inu',
  dot: 'polkadot',
  link: 'chainlink',
  matic: 'matic-network',
  bch: 'bitcoin-cash',
  ltc: 'litecoin',
  xlm: 'stellar',
  uni: 'uniswap',
  atom: 'cosmos',
  etc: 'ethereum-classic',
  fil: 'filecoin',
  near: 'near',
  algo: 'algorand',
  xmr: 'monero',
  apt: 'aptos',
  arb: 'arbitrum',
  op: 'optimism',
  hbar: 'hedera-hashgraph',
  vet: 'vechain',
  mkr: 'maker',
  aave: 'aave',
  grt: 'the-graph',
  sand: 'the-sandbox',
  mana: 'decentraland',
  cro: 'crypto-com-chain',
  xtz: 'tezos',
};

export function coinIdFor(symbol: string): string | null {
  return SYMBOL_TO_COIN_ID[symbol.trim().toLowerCase()] ?? null;
}

export interface PriceResult {
  /** Symbol → integer cents per coin (USD). */
  prices: Record<string, number>;
  /** Symbols we couldn't map to a CoinGecko id. */
  unknown: string[];
  fetchedAt: string;
}

export interface FetchPricesOptions {
  symbols: string[];
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const HOST = 'https://api.coingecko.com';

export async function fetchCryptoPrices(
  opts: FetchPricesOptions,
): Promise<PriceResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? 30_000;
  const upper = [...new Set(opts.symbols.map((s) => s.trim().toUpperCase()))]
    .filter((s) => s !== '');

  // Bucket into known vs unknown.
  const idToSymbol = new Map<string, string>();
  const unknown: string[] = [];
  for (const sym of upper) {
    const id = coinIdFor(sym);
    if (id) idToSymbol.set(id, sym);
    else unknown.push(sym);
  }

  if (idToSymbol.size === 0) {
    return {
      prices: {},
      unknown,
      fetchedAt: new Date().toISOString(),
    };
  }

  const ids = [...idToSymbol.keys()].join(',');
  const url = `${HOST}/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (res.status === 429) {
      throw new CryptoPriceError('rate_limited', 'CoinGecko rate-limited');
    }
    if (!res.ok) {
      throw new CryptoPriceError(
        'http_error',
        `CoinGecko returned HTTP ${res.status}`,
      );
    }
    const text = await res.text();
    let parsed: Record<string, { usd?: number }> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CryptoPriceError('http_error', 'CoinGecko returned non-JSON');
    }
    const prices: Record<string, number> = {};
    for (const [coinId, sym] of idToSymbol.entries()) {
      const usd = parsed[coinId]?.usd;
      if (typeof usd === 'number' && Number.isFinite(usd)) {
        // USD price × 100 → cents. Round to nearest cent.
        prices[sym] = Math.round(usd * 100);
      } else {
        // CoinGecko knew the id but returned no price — treat as unknown.
        unknown.push(sym);
      }
    }
    return { prices, unknown, fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (err instanceof CryptoPriceError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new CryptoPriceError(
        'transport_error',
        `CoinGecko request timed out after ${timeout} ms`,
      );
    }
    throw new CryptoPriceError(
      'transport_error',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}
