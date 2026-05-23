import { pool, query } from '../db/pool.js';
import { getEffectiveValue } from './settings.js';

/**
 * Multi-currency support.
 *
 *   • Display currency is global (set by super admin via the
 *     DISPLAY_CURRENCY setting; defaults to USD when unset).
 *   • Each account stays in its own currency. Money rows in the DB are
 *     integer cents of the ACCOUNT's currency — they don't get
 *     rewritten on FX changes.
 *   • Aggregations (insights, net worth, cash flow, reports) call
 *     convertToDisplay(cents, fromCurrency) to project into the display
 *     currency. The helper resolves rates lazily and caches per-call.
 *
 * Rate source: `open-er-api.com` exposes a free endpoint at
 *   https://open.er-api.com/v6/latest/<base>
 * returning a `rates` map keyed by ISO 4217 code. The fetcher writes
 * one row per pair from <base> to every other code we know about.
 *
 * Manual rows (source='manual') win over auto-fetched rows for a given
 * pair — same precedence as fuel_prices. The convert helper finds the
 * MOST RECENT row per pair regardless of source, so a fresh manual
 * write supersedes the last auto-fetch.
 */

export interface ExchangeRateRow {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  source: 'manual' | 'open-er-api' | 'frankfurter';
  fetched_at: string;
}

export interface RatesSnapshot {
  /** Latest rate per (from, to) pair. Lookup key is `${from}>${to}`. */
  map: Map<string, number>;
  fetchedAt: string | null;
}

export async function getDisplayCurrency(): Promise<string> {
  const v = (await getEffectiveValue('DISPLAY_CURRENCY')).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : 'USD';
}

export async function listRates(): Promise<ExchangeRateRow[]> {
  // Return only the most-recent rate per pair.
  const r = await query<ExchangeRateRow>(
    `SELECT DISTINCT ON (from_currency, to_currency)
            id, from_currency, to_currency, rate::float8 AS rate,
            source, fetched_at::text
       FROM exchange_rates
       ORDER BY from_currency, to_currency, fetched_at DESC`,
  );
  return r.rows;
}

export async function loadRatesSnapshot(): Promise<RatesSnapshot> {
  const rows = await listRates();
  const map = new Map<string, number>();
  let latest: string | null = null;
  for (const row of rows) {
    map.set(`${row.from_currency}>${row.to_currency}`, Number(row.rate));
    if (!latest || row.fetched_at > latest) latest = row.fetched_at;
  }
  return { map, fetchedAt: latest };
}

/**
 * Convert an integer-cents amount in `fromCurrency` to the display
 * currency. Returns integer cents in the display currency. When no
 * rate is known the function returns the amount unchanged AND surfaces
 * a flag — callers that care can decide whether to warn or hide rows.
 */
export interface ConvertResult {
  cents: number;
  rate: number;
  /** True when fromCurrency === to OR a direct rate was found. */
  rateKnown: boolean;
}

export function convert(
  amountCents: number,
  fromCurrency: string,
  toCurrency: string,
  snapshot: RatesSnapshot,
): ConvertResult {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  if (from === to) {
    return { cents: amountCents, rate: 1, rateKnown: true };
  }
  const direct = snapshot.map.get(`${from}>${to}`);
  if (typeof direct === 'number') {
    return {
      cents: Math.round(amountCents * direct),
      rate: direct,
      rateKnown: true,
    };
  }
  // Try the inverse — if a USD>EUR rate exists, the EUR>USD is 1/rate.
  const inv = snapshot.map.get(`${to}>${from}`);
  if (typeof inv === 'number' && inv > 0) {
    const rate = 1 / inv;
    return {
      cents: Math.round(amountCents * rate),
      rate,
      rateKnown: true,
    };
  }
  // No rate known — pass through with rateKnown=false so caller can flag it.
  return { cents: amountCents, rate: 1, rateKnown: false };
}

interface OpenErApiResponse {
  result?: string;
  base_code?: string;
  rates?: Record<string, number>;
}

/**
 * Fetch USD-based rates from open.er-api.com and persist one row per
 * non-USD target. Returns the count inserted. Throws on network or
 * shape errors so the route handler can surface them.
 *
 * No API key required for the free tier; the IP-based rate limit is
 * generous (once-a-day fetches are well inside it).
 */
export async function refreshRatesFromOpenErApi(): Promise<{
  inserted: number;
  base: string;
  fetchedAt: string;
}> {
  const provider = (await getEffectiveValue('FX_PROVIDER')).toLowerCase() || 'open-er-api';
  if (provider !== 'open-er-api') {
    throw new Error(
      `FX_PROVIDER='${provider}' is not supported by the auto-refresher yet`,
    );
  }
  const base = await getDisplayCurrency();
  const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'user-agent': 'smrtcash' },
  });
  if (!res.ok) {
    throw new Error(`open.er-api.com returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as OpenErApiResponse;
  if (body.result !== 'success' || !body.rates) {
    throw new Error('open.er-api.com response did not include rates');
  }
  const baseCode = (body.base_code ?? base).toUpperCase();
  const fetchedAt = new Date().toISOString();

  let inserted = 0;
  for (const [code, rate] of Object.entries(body.rates)) {
    const to = code.toUpperCase();
    if (to === baseCode) continue;
    if (typeof rate !== 'number' || rate <= 0) continue;
    await query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, source, fetched_at)
       VALUES ($1, $2, $3, 'open-er-api', $4::timestamptz)`,
      [baseCode, to, rate, fetchedAt],
    );
    inserted++;
  }
  return { inserted, base: baseCode, fetchedAt };
}

/** Write a single manual rate. Used by the "override" form. */
export async function setManualRate(
  fromCurrency: string,
  toCurrency: string,
  rate: number,
): Promise<ExchangeRateRow> {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('rate must be a positive number');
  }
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    throw new Error('currencies must be ISO 4217 three-letter codes');
  }
  if (from === to) {
    throw new Error('from and to must differ');
  }
  const r = await query<ExchangeRateRow>(
    `INSERT INTO exchange_rates (from_currency, to_currency, rate, source)
     VALUES ($1, $2, $3, 'manual')
     RETURNING id, from_currency, to_currency, rate::float8 AS rate,
               source, fetched_at::text`,
    [from, to, rate],
  );
  return r.rows[0]!;
}

/** Drop all rate rows for a pair. */
export async function clearRatesFor(
  fromCurrency: string,
  toCurrency: string,
): Promise<number> {
  const r = await pool.query(
    `DELETE FROM exchange_rates
      WHERE from_currency = $1 AND to_currency = $2`,
    [fromCurrency.toUpperCase(), toCurrency.toUpperCase()],
  );
  return r.rowCount ?? 0;
}
