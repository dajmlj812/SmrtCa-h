import { pool, query } from '../db/pool.js';
import { advanceByFrequency } from '../routes/bills.js';

/**
 * AutoMagic budget wizard projection.
 *
 * Given a target cadence (period_type), an anchor start date, and a
 * count of future periods, produce a per-period breakdown:
 *
 *   - income     — recurring_income instances landing in the window
 *   - bills      — each individual bill instance due in the window
 *   - groceries  — pre-fill from the last 8 weeks' Groceries spend
 *                  (median), scaled to the period length; editable
 *   - fuel       — weekly fuel cost across active vehicles, scaled
 *   - tolls      — weekly sum of active toll routes, scaled
 *   - flex       — implicit remainder (income − sum of the above)
 *
 * The commit step writes:
 *   - one budget row per period for Groceries / Fuel / Tolls
 *   - one budget row per (period, bill instance) with `bill_id` set
 * Existing rows are never overwritten — duplicates are skipped.
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
  semimonthly: 'monthly', // bill freq doesn't have semimonthly; the bill table only stores weekly/biweekly/monthly/yearly/one-time
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

/** [start, end) for the i-th period (0-indexed) given the cadence. */
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
  // custom — caller supplies explicit ranges; this helper isn't called.
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

interface VehicleRow {
  fuel_type: string;
  mpg: number | null;
  kwh_per_mile: number | null;
  electricity_rate_cents_per_kwh: number | null;
  weekly_avg_miles: number;
}

export interface PeriodPreview {
  index: number;
  start: string;
  end: string;
  /** Days in this period — drives the weekly→period scaling for groceries/fuel/tolls. */
  days: number;
  income: Array<{ id: string; name: string; amount_cents: number; date: string }>;
  bills: Array<{ id: string; name: string; amount_cents: number; date: string }>;
  groceriesCents: number;
  fuelCents: number;
  tollsCents: number;
  /** Total income minus everything else (bills + groceries + fuel + tolls). */
  flexCents: number;
}

export interface WizardPreview {
  periodType: WizardPeriodType;
  anchor: string;
  count: number;
  /** Source for the groceries default: median of last 8 weeks of Groceries category spend. */
  groceriesWeeklyMedianCents: number;
  /** Source for fuel: weekly cost across all active vehicles. */
  fuelWeeklyCents: number;
  /** Sum of weekly_estimate across active toll routes. */
  tollsWeeklyCents: number;
  periods: PeriodPreview[];
}

async function weeklyGroceriesMedian(): Promise<number> {
  // Last 8 calendar weeks of transactions in the seeded "Groceries" category.
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

async function weeklyFuelCents(): Promise<number> {
  const vehicles = await pool.query<VehicleRow>(
    `SELECT fuel_type, mpg::float8 AS mpg, kwh_per_mile::float8 AS kwh_per_mile,
            electricity_rate_cents_per_kwh,
            weekly_avg_miles::float8 AS weekly_avg_miles
       FROM vehicles WHERE active`,
  );
  const prices = await pool.query<{ fuel_type: string; price_cents_per_gallon: number }>(
    `SELECT fuel_type, price_cents_per_gallon FROM fuel_prices`,
  );
  const priceByGrade = new Map(prices.rows.map((p) => [p.fuel_type, Number(p.price_cents_per_gallon)]));
  let totalCents = 0;
  for (const v of vehicles.rows) {
    if (v.fuel_type === 'electric') {
      if (v.kwh_per_mile == null || v.electricity_rate_cents_per_kwh == null) continue;
      totalCents += Number(v.weekly_avg_miles) * Number(v.kwh_per_mile) * Number(v.electricity_rate_cents_per_kwh);
    } else {
      if (v.mpg == null || v.mpg <= 0) continue;
      const cpg = priceByGrade.get(v.fuel_type);
      if (cpg === undefined) continue;
      totalCents += (Number(v.weekly_avg_miles) / Number(v.mpg)) * Number(cpg);
    }
  }
  return Math.round(totalCents);
}

async function weeklyTollsCents(): Promise<number> {
  const r = await pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(weekly_estimate_cents), 0)::bigint AS total
       FROM toll_routes WHERE active`,
  );
  return Number(r.rows[0]!.total);
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
  /** Optional per-period overrides keyed by period index. */
  groceriesOverrideCents?: Record<number, number>;
  fuelOverrideCents?: Record<number, number>;
  tollsOverrideCents?: Record<number, number>;
}

export async function buildWizardPreview(input: WizardInput): Promise<WizardPreview> {
  const groceriesWeekly = await weeklyGroceriesMedian();
  const fuelWeekly = await weeklyFuelCents();
  const tollsWeekly = await weeklyTollsCents();

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
    const incomeTotal = incomeHere.reduce((acc, x) => acc + x.amount_cents, 0);
    const billsTotal = billsHere.reduce((acc, x) => acc + x.amount_cents, 0);
    const flexCents = incomeTotal - billsTotal - groceriesCents - fuelCents - tollsCents;
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
    periods,
  };
}

export interface CommitResult {
  created: number;
  skipped: number;
  perPeriod: Array<{ index: number; created: number; skipped: number }>;
}

/**
 * Write the wizard's preview rows to the database. For each period:
 *   - Groceries, Fuel, Tolls budget rows (category_id NULL, no bill_id)
 *   - one budget row per bill instance (category_id NULL, bill_id set)
 * Skip-duplicates rule:
 *   - Groceries/Fuel/Tolls — match on (period_type, period_month, label tag).
 *     We use a synthesized "label" via an existing-row check on (period, NULL category, NULL bill, amount-with-tag matching).
 *     For simplicity, we just skip if the same (period_start, category_id IS NULL, bill_id IS NULL, amount_cents) row exists.
 *   - Bill-linked — skip if a row already has (period_start, bill_id).
 *
 * The Groceries/Fuel/Tolls rows have no `category_id` (they aren't tied to a
 * single category like a normal flex pool either). The UI labels them
 * by inspecting their `memo`-equivalent... we don't have a memo column.
 *
 * IMPORTANT: budgets.amount_cents has `CHECK (amount_cents > 0)` so we
 * skip zero-amount rows entirely (a $0 groceries row is meaningless).
 */
export async function commitWizard(
  preview: WizardPreview,
): Promise<CommitResult> {
  // We need a way to label the three editable rows so the UI can show them
  // as Groceries / Fuel / Tolls without pulling from category_id. The
  // cleanest way without another schema change is to look up the existing
  // seeded category ids by name and store them on the budget row. The
  // categories taxonomy is hierarchical; we want the leaf categories.
  const catLookup = await pool.query<{ name: string; id: string }>(
    `SELECT lower(name) AS name, id FROM categories
      WHERE lower(name) IN ('groceries', 'gas & fuel', 'tolls')`,
  );
  const groceriesCat = catLookup.rows.find((r) => r.name === 'groceries')?.id ?? null;
  const fuelCat = catLookup.rows.find((r) => r.name === 'gas & fuel')?.id ?? null;
  const tollsCat = catLookup.rows.find((r) => r.name === 'tolls')?.id ?? null;

  let created = 0;
  let skipped = 0;
  const perPeriod: Array<{ index: number; created: number; skipped: number }> = [];

  for (const p of preview.periods) {
    let cCreated = 0;
    let cSkipped = 0;
    const editableInputs: Array<{ catId: string | null; amount: number }> = [
      { catId: groceriesCat, amount: p.groceriesCents },
      { catId: fuelCat, amount: p.fuelCents },
      { catId: tollsCat, amount: p.tollsCents },
    ];
    for (const e of editableInputs) {
      if (e.amount <= 0 || e.catId === null) continue;
      // Skip-duplicate: if a budget already exists for (period_start, category_id) at any period_type, skip.
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
        `INSERT INTO budgets (period_month, period_type, category_id, amount_cents)
         VALUES ($1, $2, $3, $4)`,
        [p.start, preview.periodType, e.catId, e.amount],
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
