import { pool, query } from '../db/pool.js';
import { advanceByFrequency } from '../routes/bills.js';
import { getEffectiveValue } from './settings.js';

/**
 * AutoMagic budget wizard projection (Phase 7.3 rev).
 *
 * Inputs: target cadence + anchor + count + optional per-period
 * overrides. For each future period we compute:
 *
 *   - income      — recurring_income instances projected into the window
 *   - bills       — each individual bill instance due in the window
 *   - groceries   — pre-fill from the last 8 weeks' Groceries spend
 *                   (median), scaled to the period length
 *   - fuel        — route-driven: every active commute_route's
 *                   assignments contribute (distance × crossings × per-
 *                   mile fuel rate for that vehicle); vehicles with no
 *                   assignments fall back to weekly_avg_miles
 *   - tolls       — route-driven: every active commute_route's
 *                   (toll_per_crossing × total crossings across vehicles)
 *   - misc        — defaults to $0 (one-off expenses you know about);
 *                   the user enters an amount + memo
 *   - savings     — four suggestions surface (goal-required from
 *                   savings_goals, % of income, % of flex, and the max).
 *                   The user picks one; the chosen amount writes a
 *                   Savings budget row on commit
 *   - flex        — implicit remainder = income − bills − groceries −
 *                   fuel − tolls − misc − savings
 *
 * Commit writes per-period budget rows for the four editable categories
 * (Groceries / Fuel / Tolls / Misc / Savings — five if Savings > 0) and
 * one bill-linked row per bill instance. Skip-duplicates.
 */

export type WizardPeriodType =
  | 'weekly'
  | 'biweekly'
  | 'semimonthly'
  | 'monthly'
  | 'custom';

const FREQ_TO_ADVANCE: Record<string, 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'one-time'> = {
  weekly: 'weekly',
  biweekly: 'biweekly',
  semimonthly: 'monthly',
  monthly: 'monthly',
  yearly: 'yearly',
  'one-time': 'one-time',
};

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number) as [number, number, number];
  const [yb, mb, db] = b.split('-').map(Number) as [number, number, number];
  return Math.round(
    (Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) /
      (1000 * 60 * 60 * 24),
  );
}

export function periodRange(
  type: WizardPeriodType,
  anchor: string,
  index: number,
): { start: string; end: string } {
  if (type === 'monthly') {
    const start = addMonths(anchor, index);
    return { start, end: addMonths(start, 1) };
  }
  if (type === 'weekly') {
    const start = addDays(anchor, index * 7);
    return { start, end: addDays(start, 7) };
  }
  if (type === 'biweekly') {
    const start = addDays(anchor, index * 14);
    return { start, end: addDays(start, 14) };
  }
  if (type === 'semimonthly') {
    const start = addDays(anchor, index * 15);
    return { start, end: addDays(start, 15) };
  }
  const start = addDays(anchor, index);
  return { start, end: addDays(start, 1) };
}

interface BillRow {
  id: string;
  name: string;
  amount_cents: number;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'one-time';
  next_due_date: string;
}

interface IncomeRow {
  id: string;
  name: string;
  amount_cents: number;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly';
  next_expected_date: string;
}

export interface SavingsSuggestions {
  goalRequiredCents: number;
  pctIncomeCents: number;
  pctLeftoverCents: number;
  /** max of the above three; what we recommend by default. */
  maxCents: number;
}

export interface PeriodPreview {
  index: number;
  start: string;
  end: string;
  days: number;
  income: Array<{ id: string; name: string; amount_cents: number; date: string }>;
  bills: Array<{ id: string; name: string; amount_cents: number; date: string }>;
  groceriesCents: number;
  fuelCents: number;
  tollsCents: number;
  miscCents: number;
  miscNote: string;
  savingsCents: number;
  savingsSuggestions: SavingsSuggestions;
  flexCents: number;
}

export interface WizardPreview {
  periodType: WizardPeriodType;
  anchor: string;
  count: number;
  /** Source for groceries: median of last 8 weeks of Groceries spend. */
  groceriesWeeklyMedianCents: number;
  /** Source for fuel: total route-driven weekly fuel cost. */
  fuelWeeklyCents: number;
  /** Source for tolls: total route-driven weekly toll cost. */
  tollsWeeklyCents: number;
  /** Percentage knobs from app_settings (whole numbers, e.g. 20 = 20%). */
  savingsIncomePct: number;
  savingsLeftoverPct: number;
  periods: PeriodPreview[];
}

async function weeklyGroceriesMedian(): Promise<number> {
  const r = await pool.query<{ week: string; total: number }>(
    `WITH groc AS (
       SELECT date_trunc('week', txn_date)::date AS week,
              SUM(-amount_cents)::bigint AS total
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
        WHERE lower(c.name) = 'groceries'
          AND t.amount_cents < 0
          AND t.transfer_group_id IS NULL
          AND t.txn_date >= (now()::date - interval '8 weeks')
     GROUP BY 1
     )
     SELECT to_char(week, 'YYYY-MM-DD') AS week, total FROM groc ORDER BY total`,
  );
  if (r.rowCount === 0) return 0;
  const sorted = r.rows.map((row) => Number(row.total)).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Route-driven fuel + tolls. Returns weekly totals across all active
 * routes and active vehicles.
 *
 *   per vehicle weekly miles =
 *     SUM(commute_routes.distance × assignment.crossings)
 *     for that vehicle's active-route assignments, OR
 *     vehicles.weekly_avg_miles if no active-route assignment exists.
 *
 *   weekly tolls = SUM(route.toll_per_crossing × SUM(crossings))
 *     across active routes with non-null toll.
 */
interface VehicleFuelRow {
  id: string;
  fuel_type: string;
  mpg: number | null;
  kwh_per_mile: number | null;
  electricity_rate_cents_per_kwh: number | null;
  weekly_avg_miles: number;
  assigned_miles: number;
}

async function routeDrivenWeekly(): Promise<{
  fuelCents: number;
  tollsCents: number;
}> {
  const vehicles = await pool.query<VehicleFuelRow>(
    `SELECT v.id, v.fuel_type,
            v.mpg::float8 AS mpg,
            v.kwh_per_mile::float8 AS kwh_per_mile,
            v.electricity_rate_cents_per_kwh,
            v.weekly_avg_miles::float8 AS weekly_avg_miles,
            COALESCE(SUM(cr.distance_miles * a.crossings_per_week), 0)::float8
              AS assigned_miles
       FROM vehicles v
  LEFT JOIN route_vehicle_assignments a ON a.vehicle_id = v.id
  LEFT JOIN commute_routes cr ON cr.id = a.route_id AND cr.active
      WHERE v.active
   GROUP BY v.id`,
  );
  const prices = await pool.query<{ fuel_type: string; price_cents_per_gallon: number }>(
    `SELECT fuel_type, price_cents_per_gallon FROM fuel_prices`,
  );
  const priceByGrade = new Map(
    prices.rows.map((p) => [p.fuel_type, Number(p.price_cents_per_gallon)]),
  );

  let fuelCents = 0;
  for (const v of vehicles.rows) {
    const effectiveMiles =
      v.assigned_miles > 0 ? v.assigned_miles : v.weekly_avg_miles;
    if (effectiveMiles <= 0) continue;
    if (v.fuel_type === 'electric') {
      if (v.kwh_per_mile == null || v.electricity_rate_cents_per_kwh == null) continue;
      fuelCents +=
        effectiveMiles *
        Number(v.kwh_per_mile) *
        Number(v.electricity_rate_cents_per_kwh);
    } else {
      if (v.mpg == null || v.mpg <= 0) continue;
      const cpg = priceByGrade.get(v.fuel_type);
      if (cpg === undefined) continue;
      fuelCents += (effectiveMiles / Number(v.mpg)) * Number(cpg);
    }
  }

  const tolls = await pool.query<{ total: number }>(
    `SELECT COALESCE(
       SUM(cr.toll_per_crossing_cents * COALESCE(crossings.total, 0)),
       0
     )::bigint AS total
       FROM commute_routes cr
  LEFT JOIN (
        SELECT route_id, SUM(crossings_per_week) AS total
          FROM route_vehicle_assignments
      GROUP BY route_id
     ) crossings ON crossings.route_id = cr.id
      WHERE cr.active AND cr.toll_per_crossing_cents IS NOT NULL`,
  );

  return {
    fuelCents: Math.round(fuelCents),
    tollsCents: Number(tolls.rows[0]!.total),
  };
}

/** Period-level savings suggestion: goal-required across active goals. */
async function goalRequiredForPeriod(
  periodEnd: string,
  periodDays: number,
): Promise<number> {
  const goals = await pool.query<{
    target_amount_cents: number;
    current_amount_cents: number;
    target_date: string | null;
  }>(
    `SELECT target_amount_cents, current_amount_cents,
            to_char(target_date, 'YYYY-MM-DD') AS target_date
       FROM savings_goals
      WHERE target_date IS NOT NULL`,
  );
  let total = 0;
  for (const g of goals.rows) {
    const remaining = Number(g.target_amount_cents) - Number(g.current_amount_cents);
    if (remaining <= 0) continue;
    const daysToTarget = Math.max(1, daysBetween(periodEnd, g.target_date!));
    const periodsToTarget = Math.max(1, daysToTarget / periodDays);
    total += remaining / periodsToTarget;
  }
  return Math.round(total);
}

function scaleToPeriod(weeklyCents: number, days: number): number {
  return Math.round(weeklyCents * (days / 7));
}

function instancesIn(
  rows: Array<BillRow | IncomeRow>,
  start: string,
  end: string,
  dateField: 'next_due_date' | 'next_expected_date',
): Array<{ id: string; name: string; amount_cents: number; date: string }> {
  const out: Array<{ id: string; name: string; amount_cents: number; date: string }> = [];
  for (const r of rows) {
    const indexed = r as unknown as Record<string, string>;
    let cur = indexed[dateField]!;
    const freq = indexed.frequency!;
    let safety = 0;
    while (cur < end && safety < 64) {
      safety++;
      if (cur >= start) {
        out.push({
          id: r.id,
          name: r.name,
          amount_cents: Number(r.amount_cents),
          date: cur,
        });
      }
      const next = advanceByFrequency(
        cur,
        (FREQ_TO_ADVANCE[freq] ?? 'monthly') as Parameters<typeof advanceByFrequency>[1],
      );
      if (next === null) break;
      cur = next;
    }
  }
  return out;
}

export interface WizardInput {
  periodType: WizardPeriodType;
  anchor: string;
  count: number;
  groceriesOverrideCents?: Record<number, number>;
  fuelOverrideCents?: Record<number, number>;
  tollsOverrideCents?: Record<number, number>;
  miscOverrideCents?: Record<number, number>;
  miscNoteOverride?: Record<number, string>;
  savingsOverrideCents?: Record<number, number>;
  /**
   * Per-wizard-run overrides for the suggestion percentages. When set,
   * these win over the global SAVINGS_INCOME_PCT / SAVINGS_LEFTOVER_PCT
   * settings. Useful so a tenant admin can tune the chips without the
   * super-admin having to update the global. Whole-number percentages
   * (e.g. 25 means 25%).
   */
  savingsIncomePctOverride?: number;
  savingsLeftoverPctOverride?: number;
}

export async function buildWizardPreview(input: WizardInput): Promise<WizardPreview> {
  const groceriesWeekly = await weeklyGroceriesMedian();
  const { fuelCents: fuelWeekly, tollsCents: tollsWeekly } = await routeDrivenWeekly();

  // Per-wizard-run overrides win over the global setting. Whole-number
  // percentages; outside-range values fall back to the global / default.
  const savingsIncomePctStr = await getEffectiveValue('SAVINGS_INCOME_PCT');
  const savingsLeftoverPctStr = await getEffectiveValue('SAVINGS_LEFTOVER_PCT');
  const savingsIncomePctGlobal = Number(savingsIncomePctStr) || 20;
  const savingsLeftoverPctGlobal = Number(savingsLeftoverPctStr) || 50;
  const savingsIncomePct =
    typeof input.savingsIncomePctOverride === 'number' &&
    input.savingsIncomePctOverride >= 0 &&
    input.savingsIncomePctOverride <= 100
      ? input.savingsIncomePctOverride
      : savingsIncomePctGlobal;
  const savingsLeftoverPct =
    typeof input.savingsLeftoverPctOverride === 'number' &&
    input.savingsLeftoverPctOverride >= 0 &&
    input.savingsLeftoverPctOverride <= 100
      ? input.savingsLeftoverPctOverride
      : savingsLeftoverPctGlobal;

  const bills = (
    await pool.query<BillRow>(
      `SELECT id, name, amount_cents, frequency, next_due_date
         FROM bills WHERE active`,
    )
  ).rows;
  const income = (
    await pool.query<IncomeRow>(
      `SELECT id, name, amount_cents, frequency, next_expected_date
         FROM recurring_income WHERE active`,
    )
  ).rows;

  const periods: PeriodPreview[] = [];
  for (let i = 0; i < input.count; i++) {
    const { start, end } = periodRange(input.periodType, input.anchor, i);
    const days = daysBetween(start, end);
    const billsHere = instancesIn(bills, start, end, 'next_due_date');
    const incomeHere = instancesIn(income, start, end, 'next_expected_date');
    const groceriesCents =
      input.groceriesOverrideCents?.[i] ?? scaleToPeriod(groceriesWeekly, days);
    const fuelCents = input.fuelOverrideCents?.[i] ?? scaleToPeriod(fuelWeekly, days);
    const tollsCents = input.tollsOverrideCents?.[i] ?? scaleToPeriod(tollsWeekly, days);
    const miscCents = input.miscOverrideCents?.[i] ?? 0;
    const miscNote = input.miscNoteOverride?.[i] ?? '';
    const incomeTotal = incomeHere.reduce((acc, x) => acc + x.amount_cents, 0);
    const billsTotal = billsHere.reduce((acc, x) => acc + x.amount_cents, 0);

    // Savings suggestions — computed BEFORE the user's chosen value so
    // the four numbers are always visible.
    const goalRequiredCents = await goalRequiredForPeriod(end, days);
    const pctIncomeCents = Math.round(incomeTotal * (savingsIncomePct / 100));
    const preFlexCents =
      incomeTotal - billsTotal - groceriesCents - fuelCents - tollsCents - miscCents;
    const pctLeftoverCents =
      preFlexCents > 0 ? Math.round(preFlexCents * (savingsLeftoverPct / 100)) : 0;
    const maxCents = Math.max(goalRequiredCents, pctIncomeCents, pctLeftoverCents);

    const savingsCents = input.savingsOverrideCents?.[i] ?? 0;

    const flexCents =
      incomeTotal -
      billsTotal -
      groceriesCents -
      fuelCents -
      tollsCents -
      miscCents -
      savingsCents;

    periods.push({
      index: i,
      start,
      end,
      days,
      income: incomeHere,
      bills: billsHere,
      groceriesCents,
      fuelCents,
      tollsCents,
      miscCents,
      miscNote,
      savingsCents,
      savingsSuggestions: {
        goalRequiredCents,
        pctIncomeCents,
        pctLeftoverCents,
        maxCents,
      },
      flexCents,
    });
  }

  return {
    periodType: input.periodType,
    anchor: input.anchor,
    count: input.count,
    groceriesWeeklyMedianCents: groceriesWeekly,
    fuelWeeklyCents: fuelWeekly,
    tollsWeeklyCents: tollsWeekly,
    savingsIncomePct,
    savingsLeftoverPct,
    periods,
  };
}

export interface CommitResult {
  created: number;
  skipped: number;
  perPeriod: Array<{ index: number; created: number; skipped: number }>;
}

export async function commitWizard(
  preview: WizardPreview,
): Promise<CommitResult> {
  const catLookup = await pool.query<{ name: string; id: string }>(
    `SELECT lower(name) AS name, id FROM categories
      WHERE lower(name) IN ('groceries', 'gas & fuel', 'tolls', 'miscellaneous', 'savings')`,
  );
  const byName = new Map(catLookup.rows.map((r) => [r.name, r.id]));
  const groceriesCat = byName.get('groceries') ?? null;
  const fuelCat = byName.get('gas & fuel') ?? null;
  const tollsCat = byName.get('tolls') ?? null;
  const miscCat = byName.get('miscellaneous') ?? null;
  const savingsCat = byName.get('savings') ?? null;

  let created = 0;
  let skipped = 0;
  const perPeriod: Array<{ index: number; created: number; skipped: number }> = [];

  for (const p of preview.periods) {
    let cCreated = 0;
    let cSkipped = 0;
    const editableInputs: Array<{
      catId: string | null;
      amount: number;
      note: string | null;
    }> = [
      { catId: groceriesCat, amount: p.groceriesCents, note: null },
      { catId: fuelCat, amount: p.fuelCents, note: null },
      { catId: tollsCat, amount: p.tollsCents, note: null },
      { catId: miscCat, amount: p.miscCents, note: p.miscNote || null },
      { catId: savingsCat, amount: p.savingsCents, note: null },
    ];
    for (const e of editableInputs) {
      if (e.amount <= 0 || e.catId === null) continue;
      const existing = await pool.query(
        `SELECT 1 FROM budgets
          WHERE period_month = $1::date
            AND category_id = $2
          LIMIT 1`,
        [p.start, e.catId],
      );
      if (existing.rowCount! > 0) {
        cSkipped++;
        continue;
      }
      await query(
        `INSERT INTO budgets (period_month, period_type, category_id, amount_cents, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [p.start, preview.periodType, e.catId, e.amount, e.note],
      );
      cCreated++;
    }

    for (const bill of p.bills) {
      if (bill.amount_cents <= 0) continue;
      const existing = await pool.query(
        `SELECT 1 FROM budgets
          WHERE period_month = $1::date AND bill_id = $2 LIMIT 1`,
        [p.start, bill.id],
      );
      if (existing.rowCount! > 0) {
        cSkipped++;
        continue;
      }
      await query(
        `INSERT INTO budgets (period_month, period_type, bill_id, amount_cents)
         VALUES ($1, $2, $3, $4)`,
        [p.start, preview.periodType, bill.id, bill.amount_cents],
      );
      cCreated++;
    }

    perPeriod.push({ index: p.index, created: cCreated, skipped: cSkipped });
    created += cCreated;
    skipped += cSkipped;
  }

  return { created, skipped, perPeriod };
}
