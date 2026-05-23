import { config } from '../config.js';
import { pool, query } from '../db/pool.js';

/**
 * Fuel-price layer. Two paths:
 *
 * - **Manual override** — any row in `fuel_prices` with `source='manual'`
 *   wins for that grade. The user sets these from the /vehicles page when
 *   they don't trust the cached EIA value (or have no EIA key).
 * - **EIA cached** — when `EIA_API_KEY` is configured, `fetchFromEia()`
 *   pulls the latest weekly US national average for each grade and
 *   upserts rows with `source='eia'`. Cached locally; only re-fetched
 *   when the user clicks "Refresh from EIA" or the cache is older than
 *   STALE_AFTER_MS.
 *
 * Grade → EIA series mapping (US, weekly retail prices):
 *   regular   EMM_EPMR_PTE_NUS_DPG  ($/gal)
 *   midgrade  EMM_EPMM_PTE_NUS_DPG
 *   premium   EMM_EPMP_PTE_NUS_DPG
 *   diesel    EMD_EPD2D_PTE_NUS_DPG
 *
 * Electric vehicles have no EIA source — the per-vehicle
 * electricity_rate_cents_per_kwh on the vehicle row is the user's
 * authority.
 */

export type FuelGrade = 'regular' | 'midgrade' | 'premium' | 'diesel';

const EIA_SERIES: Record<FuelGrade, string> = {
  regular: 'EMM_EPMR_PTE_NUS_DPG',
  midgrade: 'EMM_EPMM_PTE_NUS_DPG',
  premium: 'EMM_EPMP_PTE_NUS_DPG',
  diesel: 'EMD_EPD2D_PTE_NUS_DPG',
};

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

export interface FuelPriceRow {
  fuel_type: FuelGrade;
  price_cents_per_gallon: number;
  source: 'eia' | 'manual';
  fetched_at: string;
}

export async function listFuelPrices(): Promise<FuelPriceRow[]> {
  const r = await query<FuelPriceRow>(
    `SELECT fuel_type, price_cents_per_gallon, source, fetched_at
       FROM fuel_prices
      ORDER BY fuel_type`,
  );
  return r.rows;
}

/** Upsert a manual price override. */
export async function setManualFuelPrice(
  grade: FuelGrade,
  priceCentsPerGallon: number,
): Promise<FuelPriceRow> {
  if (!Number.isInteger(priceCentsPerGallon) || priceCentsPerGallon < 0) {
    throw new Error('price_cents_per_gallon must be a non-negative integer');
  }
  const r = await query<FuelPriceRow>(
    `INSERT INTO fuel_prices (fuel_type, price_cents_per_gallon, source)
     VALUES ($1, $2, 'manual')
     ON CONFLICT (fuel_type) DO UPDATE
       SET price_cents_per_gallon = EXCLUDED.price_cents_per_gallon,
           source                 = 'manual',
           fetched_at             = now()
     RETURNING fuel_type, price_cents_per_gallon, source, fetched_at`,
    [grade, priceCentsPerGallon],
  );
  return r.rows[0]!;
}

interface EiaResponse {
  response: {
    data: Array<{
      period: string;
      value: number | string | null;
    }>;
  };
}

/** Fetch the most recent value from EIA for one grade. Returns null on failure. */
async function fetchSeriesPriceUsd(
  grade: FuelGrade,
  apiKey: string,
): Promise<number | null> {
  const url = new URL('https://api.eia.gov/v2/seriesid/PET.' + EIA_SERIES[grade] + '.W');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('length', '1');
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');

  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) return null;
  const body = (await res.json()) as EiaResponse;
  const first = body.response?.data?.[0];
  if (!first || first.value == null) return null;
  const dollars =
    typeof first.value === 'number' ? first.value : Number(first.value);
  return Number.isFinite(dollars) ? dollars : null;
}

/**
 * Pull the latest EIA prices and upsert them. Each grade is updated
 * independently — one failure does not block the others. A manual
 * override is *not* overwritten (the user's choice wins).
 */
export async function refreshFromEia(): Promise<{
  refreshed: FuelGrade[];
  skippedManual: FuelGrade[];
  failed: FuelGrade[];
  configured: boolean;
}> {
  const apiKey = config.eiaApiKey;
  if (!apiKey) {
    return { refreshed: [], skippedManual: [], failed: [], configured: false };
  }
  const existing = await pool.query<{ fuel_type: FuelGrade; source: 'eia' | 'manual' }>(
    `SELECT fuel_type, source FROM fuel_prices`,
  );
  const manual = new Set(
    existing.rows.filter((r) => r.source === 'manual').map((r) => r.fuel_type),
  );

  const refreshed: FuelGrade[] = [];
  const skippedManual: FuelGrade[] = [];
  const failed: FuelGrade[] = [];
  for (const grade of Object.keys(EIA_SERIES) as FuelGrade[]) {
    if (manual.has(grade)) {
      skippedManual.push(grade);
      continue;
    }
    const dollars = await fetchSeriesPriceUsd(grade, apiKey);
    if (dollars === null) {
      failed.push(grade);
      continue;
    }
    const cents = Math.round(dollars * 100);
    await query(
      `INSERT INTO fuel_prices (fuel_type, price_cents_per_gallon, source)
       VALUES ($1, $2, 'eia')
       ON CONFLICT (fuel_type) DO UPDATE
         SET price_cents_per_gallon = EXCLUDED.price_cents_per_gallon,
             source                 = 'eia',
             fetched_at             = now()
       WHERE fuel_prices.source <> 'manual'`,
      [grade, cents],
    );
    refreshed.push(grade);
  }
  return { refreshed, skippedManual, failed, configured: true };
}
