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

export interface BillRow {
  id: string;
  name: string;
  amount_cents: number;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'one-time';
  next_due_date: string;
}

export interface IncomeRow {
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
  /** 0.17.6 — carries from buildWizardPreview() into commitWizard() so the latter doesn't re-derive scope. */
  tenantId: string;
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

async function weeklyGroceriesMedian(
  tenantId: string,
  accountIds: string[] | null,
): Promise<number> {
  // 0.17.6 — tenant-scoped via accounts JOIN. Pre-fix this aggregated
  // groceries across every tenant in the database; on a multi-tenant
  // deploy that meant tenant A's wizard preview included tenant B's
  // grocery spend in the median.
  //
  // 0.17.8 — optional account-IDs filter so the user can pick which
  // accounts contribute to the median. Passing NULL = all accounts;
  // a non-empty array = only those accounts; an empty array still
  // means "all" (the SQL `($2::uuid[] IS NULL OR ...)` treats an
  // empty array as the no-filter case via the IS NULL check we
  // route through in the caller).
  const r = await pool.query<{ week: string; total: number }>(
    `WITH groc AS (
       SELECT date_trunc('week', txn_date)::date AS week,
              SUM(-amount_cents)::bigint AS total
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN categories c ON c.id = t.category_id
        WHERE a.tenant_id = $1
          AND ($2::uuid[] IS NULL OR a.id = ANY($2::uuid[]))
          AND lower(c.name) = 'groceries'
          AND t.amount_cents < 0
          AND t.transfer_group_id IS NULL
          AND t.txn_date >= (now()::date - interval '8 weeks')
     GROUP BY 1
     )
     SELECT to_char(week, 'YYYY-MM-DD') AS week, total FROM groc ORDER BY total`,
    [tenantId, accountIds],
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

async function routeDrivenWeekly(tenantId: string): Promise<{
  fuelCents: number;
  tollsCents: number;
}> {
  // 0.17.6 — tenant scope. Vehicles + commute_routes both gained
  // tenant_id in 0.11.0 (multi-tenant phase) but this aggregation
  // never picked it up; on a multi-tenant deploy, tenant A's
  // wizard preview would mix in tenant B's vehicles and tolls.
  // fuel_prices is global (it's an EIA-driven price index) — no
  // tenant scope needed there.
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
  LEFT JOIN commute_routes cr ON cr.id = a.route_id AND cr.active AND cr.tenant_id = $1
      WHERE v.active AND v.tenant_id = $1
   GROUP BY v.id`,
    [tenantId],
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
      WHERE cr.active
        AND cr.toll_per_crossing_cents IS NOT NULL
        AND cr.tenant_id = $1`,
    [tenantId],
  );

  return {
    fuelCents: Math.round(fuelCents),
    tollsCents: Number(tolls.rows[0]!.total),
  };
}

/** Period-level savings suggestion: goal-required across active goals. */
async function goalRequiredForPeriod(
  tenantId: string,
  periodEnd: string,
  periodDays: number,
): Promise<number> {
  // 0.17.6 — tenant scope. savings_goals has tenant_id since
  // 0.11.0 multi-tenant; the wizard never filtered.
  const goals = await pool.query<{
    target_amount_cents: number;
    current_amount_cents: number;
    target_date: string | null;
  }>(
    `SELECT target_amount_cents, current_amount_cents,
            to_char(target_date, 'YYYY-MM-DD') AS target_date
       FROM savings_goals
      WHERE target_date IS NOT NULL AND tenant_id = $1`,
    [tenantId],
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

/**
 * 0.17.7 — exported so the new /api/budgets/period endpoint can
 * compute income + bill instances in the same way the wizard
 * preview does. The shape is intentionally identical so the
 * cash-flow view on /budgets matches what the wizard previewed.
 */
export function instancesIn(
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
  /**
   * 0.17.6 — tenant scope, REQUIRED. Pre-fix the wizard read
   * bills/income/vehicles/routes/transactions across every
   * tenant and INSERTed budget rows with tenant_id=NULL,
   * making them invisible from /budgets. The route now passes
   * the caller's tenantId; every helper joins through accounts
   * or filters by tenant_id directly.
   */
  tenantId: string;
  /**
   * 0.17.8 — optional list of account IDs to INCLUDE. When set,
   * the wizard only considers bills, recurring_income, and
   * grocery transactions associated with these accounts. Bills
   * and income with a NULL account_id are treated as
   * household-wide and ALWAYS included regardless (they apply
   * to every account by design). Undefined or empty array =
   * include every account.
   *
   * Vehicles + commute routes are NOT account-scoped (they're
   * tied to the household, not a specific account) so this
   * filter doesn't affect the fuel + tolls calculation.
   */
  accountIds?: string[];
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
  // 0.17.8 — normalize empty array to null so the SQL "IS NULL"
  // sentinel works (an empty array would otherwise filter every row).
  const accountIds =
    input.accountIds && input.accountIds.length > 0 ? input.accountIds : null;
  const groceriesWeekly = await weeklyGroceriesMedian(input.tenantId, accountIds);
  const { fuelCents: fuelWeekly, tollsCents: tollsWeekly } = await routeDrivenWeekly(
    input.tenantId,
  );

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

  // 0.17.8 — when accountIds is set, include bills/income tied to
  // those accounts AS WELL AS rows with NULL account_id (the
  // "household-wide" set). Null-account rows apply to every
  // account by design, so excluding them when the user picks a
  // subset would silently drop legitimate items.
  const bills = (
    await pool.query<BillRow>(
      `SELECT id, name, amount_cents, frequency, next_due_date
         FROM bills
        WHERE active
          AND tenant_id = $1
          AND ($2::uuid[] IS NULL OR account_id IS NULL OR account_id = ANY($2::uuid[]))`,
      [input.tenantId, accountIds],
    )
  ).rows;
  const income = (
    await pool.query<IncomeRow>(
      `SELECT id, name, amount_cents, frequency, next_expected_date
         FROM recurring_income
        WHERE active
          AND tenant_id = $1
          AND ($2::uuid[] IS NULL OR account_id IS NULL OR account_id = ANY($2::uuid[]))`,
      [input.tenantId, accountIds],
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
    const goalRequiredCents = await goalRequiredForPeriod(input.tenantId, end, days);
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
    tenantId: input.tenantId,
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
  // 0.17.6 — categories.tenant_id may be NULL (system-seeded defaults)
  // OR the tenant's own. We want either match. The seeded defaults are
  // the common case (every tenant starts with them), but tenants can
  // create custom categories of the same name; in that case we prefer
  // the tenant's own.
  const catLookup = await pool.query<{ name: string; id: string }>(
    `SELECT DISTINCT ON (lower(name)) lower(name) AS name, id FROM categories
      WHERE lower(name) IN ('groceries', 'gas & fuel', 'tolls', 'miscellaneous', 'savings')
        AND (tenant_id = $1 OR tenant_id IS NULL)
      ORDER BY lower(name), tenant_id NULLS LAST`,
    [preview.tenantId],
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
      // 0.17.6 — dup-check + INSERT now both tenant-scoped. Pre-fix
      // the dup-check would falsely-positive across tenants (two
      // households running the wizard on the same period would each
      // create one and skip the other) and the INSERT would orphan
      // the row with tenant_id=NULL.
      const existing = await pool.query(
        `SELECT 1 FROM budgets
          WHERE tenant_id = $1
            AND period_month = $2::date
            AND category_id = $3
          LIMIT 1`,
        [preview.tenantId, p.start, e.catId],
      );
      if (existing.rowCount! > 0) {
        cSkipped++;
        continue;
      }
      await query(
        `INSERT INTO budgets (tenant_id, period_month, period_type, category_id, amount_cents, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [preview.tenantId, p.start, preview.periodType, e.catId, e.amount, e.note],
      );
      cCreated++;
    }

    for (const bill of p.bills) {
      if (bill.amount_cents <= 0) continue;
      const existing = await pool.query(
        `SELECT 1 FROM budgets
          WHERE tenant_id = $1
            AND period_month = $2::date
            AND bill_id = $3
          LIMIT 1`,
        [preview.tenantId, p.start, bill.id],
      );
      if (existing.rowCount! > 0) {
        cSkipped++;
        continue;
      }
      await query(
        `INSERT INTO budgets (tenant_id, period_month, period_type, bill_id, amount_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [preview.tenantId, p.start, preview.periodType, bill.id, bill.amount_cents],
      );
      cCreated++;
    }

    perPeriod.push({ index: p.index, created: cCreated, skipped: cSkipped });
    created += cCreated;
    skipped += cSkipped;
  }

  return { created, skipped, perPeriod };
}
