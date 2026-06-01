import { pool, query } from '../db/pool.js';
import { advanceByFrequency } from '../routes/bills.js';
import { getEffectiveValue, type SettingKey } from './settings.js';

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
  /** 0.17.12 — surfaced so per-period scope filtering can run. NULL = household-wide. */
  account_id: string | null;
}

export interface IncomeRow {
  id: string;
  name: string;
  amount_cents: number;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly';
  next_expected_date: string;
  /** 0.17.12 — surfaced so per-period scope filtering can run. NULL = household-wide. */
  account_id: string | null;
}

/**
 * 0.17.22 — savings suggestion chips.
 *
 * Pre-rev: two chips (% of income, % of leftover) plus
 * goal-required + a max-of-the-three "Max" chip. The user
 * asked for a simpler, all-leftover model: three percentage
 * bands of post-deduction leftover (25/50/75% by default,
 * editable) plus a "Max" chip that's the full leftover. Goal-
 * required stays as-is (driven by `savings_goals`).
 *
 * "Post-deduction leftover" = income − bills − groceries − fuel −
 * tolls − misc. Savings itself is NOT subtracted (that's the
 * whole point of these chips — figuring out how much savings to
 * carve out).
 */
export interface SavingsSuggestions {
  goalRequiredCents: number;
  pctLowCents: number;
  pctMidCents: number;
  pctHighCents: number;
  /** 100% of leftover — the upper bound chip. */
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
  /**
   * 0.21.x — parent-level recurring categories that auto-seed on
   * commit (Food at home / Food out / Gas & Fuel / Parking /
   * Taxi & Rideshare). Each entry's amount = the category's
   * trailing 12-week weekly average, scaled to this period's day
   * count and rolled up across its children. Read-only in the
   * wizard; the user can edit on the budget page after commit.
   */
  recurring: Array<{
    category_id: string;
    category_name: string;
    amount_cents: number;
  }>;
}

export interface WizardPreview extends WizardInputSavings {
  /** 0.17.6 — carries from buildWizardPreview() into commitWizard() so the latter doesn't re-derive scope. */
  tenantId: string;
  /** 0.17.16 — plan name; commitWizard creates the plan row before per-period budgets. */
  name: string;
  /**
   * 0.17.11 — same accountIds the wizard input carried. Written to
   * each committed budget row as `included_account_ids` so later
   * actuals calculations filter transactions by the same scope the
   * wizard used. Undefined or empty = no scope (every account
   * counts; legacy behavior).
   */
  accountIds?: string[];
  /**
   * 0.17.22 — destination savings account for this plan. Stored on
   * the budget_plans row; the wizard UI offers the user's savings-
   * type accounts to choose from.
   */
  savingsAccountId?: string | null;
  periodType: WizardPeriodType;
  anchor: string;
  count: number;
  /** Source for groceries: median of last 8 weeks of Groceries spend. */
  groceriesWeeklyMedianCents: number;
  /** Source for fuel: total route-driven weekly fuel cost. */
  fuelWeeklyCents: number;
  /** Source for tolls: total route-driven weekly toll cost. */
  tollsWeeklyCents: number;
  /**
   * 0.17.22 — three configurable percentages of post-deduction
   * leftover used for the chips. Defaults 25/50/75. Whole-number
   * percentages; clamped to [0, 100].
   */
  savingsLowPct: number;
  savingsMidPct: number;
  savingsHighPct: number;
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

async function routeDrivenWeekly(
  tenantId: string,
  accountIds: string[] | null,
): Promise<{
  fuelCents: number;
  tollsCents: number;
}> {
  // 0.17.6 — tenant scope. Vehicles + commute_routes both gained
  // tenant_id in 0.11.0 (multi-tenant phase) but this aggregation
  // never picked it up; on a multi-tenant deploy, tenant A's
  // wizard preview would mix in tenant B's vehicles and tolls.
  // fuel_prices is global (it's an EIA-driven price index) — no
  // tenant scope needed there.
  //
  // 0.17.20 — strict account scope (matches bills + income).
  // When accountIds is non-null, only vehicles + commute_routes
  // tagged to one of those accounts contribute. NULL account_id
  // on a vehicle/route is excluded from scoped wizard runs — the
  // user must tag the item to an account or accept that it
  // doesn't appear on any per-account plan.
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
  LEFT JOIN commute_routes cr ON cr.id = a.route_id
                              AND cr.active
                              AND cr.tenant_id = $1
                              AND ($2::uuid[] IS NULL OR cr.account_id = ANY($2::uuid[]))
      WHERE v.active
        AND v.tenant_id = $1
        AND ($2::uuid[] IS NULL OR v.account_id = ANY($2::uuid[]))
   GROUP BY v.id`,
    [tenantId, accountIds],
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
        AND cr.tenant_id = $1
        AND ($2::uuid[] IS NULL OR cr.account_id = ANY($2::uuid[]))`,
    [tenantId, accountIds],
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
  accountIds: string[] | null,
): Promise<number> {
  // 0.17.6 — tenant scope. savings_goals has tenant_id since
  // 0.11.0 multi-tenant; the wizard never filtered.
  //
  // 0.17.21 — strict account scope. When the wizard ran with
  // an account filter, only goals tagged to those accounts
  // contribute. NULL-account goals are excluded from scoped
  // runs (matching bills/income/vehicles/routes). NULL
  // accountIds = no filter, every goal counts (legacy
  // behavior).
  const goals = await pool.query<{
    target_amount_cents: number;
    current_amount_cents: number;
    target_date: string | null;
  }>(
    `SELECT target_amount_cents, current_amount_cents,
            to_char(target_date, 'YYYY-MM-DD') AS target_date
       FROM savings_goals
      WHERE target_date IS NOT NULL
        AND tenant_id = $1
        AND ($2::uuid[] IS NULL OR account_id = ANY($2::uuid[]))`,
    [tenantId, accountIds],
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

/** 0.17.22 — pass-through field on the input. */
interface WizardInputSavings {
  /** Savings destination account id; stored on the plan row. */
  savingsAccountId?: string | null;
}

export interface WizardInput extends WizardInputSavings {
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
   * 0.17.16 — name for the plan this wizard run creates.
   * Required; uniqueness enforced at DB layer via
   * `(tenant_id, name)`.
   */
  name: string;
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
   * 0.17.22 — three per-run overrides for the chip percentages.
   * Defaults 25/50/75; the user can tune each independently from
   * the wizard UI without touching global settings. Whole-number
   * percentages (e.g. 25 = 25%); out-of-range values fall back
   * to the default.
   */
  savingsLowPctOverride?: number;
  savingsMidPctOverride?: number;
  savingsHighPctOverride?: number;
  /**
   * 0.21.x — per-run overrides for the five recurring-category
   * rows (Food at home / Food out / Gas & Fuel / Parking / Taxi
   * & Rideshare). Keyed by category UUID. Each value is a
   * sparse array: `[period_idx] = amount_cents` for any period
   * where the user replaced the auto-computed amount.
   */
  recurringOverrideCents?: Record<string, Record<number, number>>;
  /**
   * 0.21.x — UUIDs of recurring categories the user opted out of
   * for this wizard run. Disabled categories are omitted from
   * every period's `recurring` array.
   */
  recurringDisabled?: string[];
}

export async function buildWizardPreview(input: WizardInput): Promise<WizardPreview> {
  // 0.17.8 — normalize empty array to null so the SQL "IS NULL"
  // sentinel works (an empty array would otherwise filter every row).
  const accountIds =
    input.accountIds && input.accountIds.length > 0 ? input.accountIds : null;
  const groceriesWeekly = await weeklyGroceriesMedian(input.tenantId, accountIds);
  const { fuelCents: fuelWeekly, tollsCents: tollsWeekly } = await routeDrivenWeekly(
    input.tenantId,
    accountIds,
  );

  // 0.21.x — resolve the five parent-level recurring categories
  // + their trailing 12-week weekly averages (rolled up across
  // children) so the preview can show what'll seed on commit.
  const recurringResolved = await pool.query<{ id: string; name: string }>(
    `SELECT DISTINCT ON (lower(name)) id, name FROM categories
      WHERE lower(name) = ANY($1::text[])
        AND (tenant_id = $2 OR tenant_id IS NULL)
      ORDER BY lower(name), tenant_id NULLS LAST`,
    [PAYCHECK_RECURRING_CATEGORIES.map((n) => n.toLowerCase()), input.tenantId],
  );
  const recurringCategoryRows = recurringResolved.rows;
  const recurringWeeklyMap = await weeklyRecurringByCategory(
    input.tenantId,
    accountIds,
    recurringCategoryRows.map((r) => r.id),
  );

  // 0.17.22 — three leftover-pct chips, defaults 25/50/75. Each
  // can be overridden per wizard run; out-of-range values fall
  // back to the default. Global setting keys still consulted for
  // backward compat; missing/invalid keys = use the literal defaults.
  function pickPct(
    override: number | undefined,
    settingKey: SettingKey,
    defaultPct: number,
  ): Promise<number> {
    return getEffectiveValue(settingKey).then((raw) => {
      // An unset setting comes back as '' from getEffectiveValue (these
      // keys have no SETTING_DEFAULTS entry). `Number('')` is 0, which
      // would slip through the 0..100 range check and silently override
      // the intended code default with 0% — so treat a blank/whitespace
      // global as "unset" and fall back to defaultPct.
      const trimmed = raw.trim();
      const globalPct = trimmed === '' ? NaN : Number(trimmed);
      const base = Number.isFinite(globalPct) && globalPct >= 0 && globalPct <= 100
        ? globalPct
        : defaultPct;
      if (
        typeof override === 'number' &&
        Number.isFinite(override) &&
        override >= 0 &&
        override <= 100
      ) {
        return override;
      }
      return base;
    });
  }
  const savingsLowPct = await pickPct(
    input.savingsLowPctOverride,
    'SAVINGS_PCT_LOW',
    25,
  );
  const savingsMidPct = await pickPct(
    input.savingsMidPctOverride,
    'SAVINGS_PCT_MID',
    50,
  );
  const savingsHighPct = await pickPct(
    input.savingsHighPctOverride,
    'SAVINGS_PCT_HIGH',
    75,
  );

  // 0.17.17 — strict scope. Pre-0.17.16 we included NULL
  // account_id rows as "household-wide" so a tenant with only
  // one budget wouldn't lose untagged bills. With per-account
  // plans this leaks: an untagged bill would join every plan's
  // preview. Now: if the wizard runs with an account filter,
  // ONLY bills/income tagged to one of those accounts feed in.
  // No filter = include everything (untagged + tagged).
  const bills = (
    await pool.query<BillRow>(
      `SELECT id, name, amount_cents, frequency, next_due_date
         FROM bills
        WHERE active
          AND tenant_id = $1
          AND ($2::uuid[] IS NULL OR account_id = ANY($2::uuid[]))`,
      [input.tenantId, accountIds],
    )
  ).rows;
  const income = (
    await pool.query<IncomeRow>(
      `SELECT id, name, amount_cents, frequency, next_expected_date
         FROM recurring_income
        WHERE active
          AND tenant_id = $1
          AND ($2::uuid[] IS NULL OR account_id = ANY($2::uuid[]))`,
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

    // 0.17.22 — savings suggestions: goal-required (from
    // savings_goals) plus three percentages of post-deduction
    // leftover plus Max (= 100% of leftover).
    const goalRequiredCents = await goalRequiredForPeriod(
      input.tenantId,
      end,
      days,
      accountIds,
    );
    // 0.21.x — recurring category amounts for this period.
    // Honors per-user disabled set and per-period overrides.
    const disabledSet = new Set(input.recurringDisabled ?? []);
    const recurring = recurringCategoryRows
      .filter((cat) => !disabledSet.has(cat.id))
      .map((cat) => {
        const override = input.recurringOverrideCents?.[cat.id]?.[i];
        const weekly = recurringWeeklyMap.get(cat.id) ?? 0;
        const auto = weekly > 0 ? scaleToPeriod(weekly, days) : 0;
        return {
          category_id: cat.id,
          category_name: cat.name,
          amount_cents:
            typeof override === 'number' && Number.isFinite(override) && override >= 0
              ? override
              : auto,
        };
      })
      .filter((r) => r.amount_cents > 0);
    const recurringTotal = recurring.reduce((s, r) => s + r.amount_cents, 0);

    const preFlexCents =
      incomeTotal - billsTotal - recurringTotal - miscCents;
    const positiveLeftover = preFlexCents > 0 ? preFlexCents : 0;
    const pctLowCents = Math.round(positiveLeftover * (savingsLowPct / 100));
    const pctMidCents = Math.round(positiveLeftover * (savingsMidPct / 100));
    const pctHighCents = Math.round(positiveLeftover * (savingsHighPct / 100));
    const maxCents = positiveLeftover;

    const savingsCents = input.savingsOverrideCents?.[i] ?? 0;

    const flexCents =
      incomeTotal - billsTotal - recurringTotal - miscCents - savingsCents;

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
        pctLowCents,
        pctMidCents,
        pctHighCents,
        maxCents,
      },
      flexCents,
      recurring,
    });
  }

  return {
    tenantId: input.tenantId,
    name: input.name,
    // 0.17.11 — pass through to commit so the scope lands on each row.
    ...(input.accountIds && input.accountIds.length > 0
      ? { accountIds: input.accountIds }
      : {}),
    // 0.17.22 — pass through savings destination so commit can stamp the plan.
    savingsAccountId: input.savingsAccountId ?? null,
    periodType: input.periodType,
    anchor: input.anchor,
    count: input.count,
    groceriesWeeklyMedianCents: groceriesWeekly,
    fuelWeeklyCents: fuelWeekly,
    tollsWeeklyCents: tollsWeekly,
    savingsLowPct,
    savingsMidPct,
    savingsHighPct,
    periods,
  };
}

export interface CommitResult {
  /** 0.17.16 — the plan_id created for this wizard run. */
  planId: string;
  created: number;
  skipped: number;
  perPeriod: Array<{ index: number; created: number; skipped: number }>;
}

/**
 * 0.17.16 — invariant check before the wizard creates a plan:
 * none of the accounts the new plan claims may already belong
 * to another plan in this tenant. Throws on overlap so the
 * route layer can turn it into a 409.
 */
export async function ensureAccountsUnclaimed(
  tenantId: string,
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  const r = await pool.query<{ name: string; conflicting: string[] }>(
    `SELECT name, ARRAY(
       SELECT a FROM unnest(account_ids) AS a
        WHERE a = ANY($2::uuid[])
     ) AS conflicting
       FROM budget_plans
      WHERE tenant_id = $1
        AND account_ids && $2::uuid[]`,
    [tenantId, accountIds],
  );
  if (r.rowCount! > 0) {
    const first = r.rows[0]!;
    throw new Error(
      `Account already in plan "${first.name}"; each account can belong to at most one plan.`,
    );
  }
}

/**
 * 0.21.x — recurring spend categories the paycheck wizard seeds
 * alongside groceries/fuel/tolls. Parent categories (Food at
 * home, Food out) roll up their children's spend automatically;
 * leaf categories use their own.
 */
const PAYCHECK_RECURRING_CATEGORIES = [
  'Food at home',
  'Food out',
  'Gas & Fuel',
  'Parking',
  'Taxi & Rideshare',
];

/**
 * For each target category (named in PAYCHECK_RECURRING_CATEGORIES),
 * compute the average weekly spend over the trailing 12 weeks
 * INCLUDING any child categories. "Food at home" → sums spend on
 * itself + Groceries + Food Delivery, etc.
 *
 * Returns a Map keyed by the TARGET category id (the parent /
 * named one), value = average weekly cents.
 */
async function weeklyRecurringByCategory(
  tenantId: string,
  accountIds: string[] | null,
  targetIds: readonly string[],
): Promise<Map<string, number>> {
  if (targetIds.length === 0) return new Map();
  // For each target id, build the set of "matching" category ids:
  // the target itself + every category whose parent_id is the
  // target. (The canonical taxonomy is 2-level so direct-children
  // is enough.) Then compute the weekly average over the union.
  const r = await pool.query<{ target_id: string; weekly: string }>(
    `WITH targets AS (
       SELECT t.id AS target_id, ARRAY(
         SELECT id FROM categories
          WHERE id = t.id OR parent_id = t.id
       ) AS matching_ids
         FROM categories t
        WHERE t.id = ANY($3::uuid[])
     ),
     weekly AS (
       SELECT tg.target_id,
              date_trunc('week', tr.txn_date) AS w,
              SUM(-tr.amount_cents)::bigint   AS weekly_spend
         FROM targets tg
         JOIN transactions tr ON tr.category_id = ANY(tg.matching_ids)
         JOIN accounts a       ON a.id = tr.account_id
        WHERE a.tenant_id = $1
          AND ($2::uuid[] IS NULL OR a.id = ANY($2::uuid[]))
          AND tr.amount_cents  < 0
          AND tr.transfer_group_id IS NULL
          AND tr.txn_date >= (now()::date - interval '12 weeks')
        GROUP BY tg.target_id, date_trunc('week', tr.txn_date)
     )
     SELECT target_id, ROUND(AVG(weekly_spend))::bigint::text AS weekly
       FROM weekly
   GROUP BY target_id`,
    [tenantId, accountIds, targetIds],
  );
  const out = new Map<string, number>();
  for (const row of r.rows) out.set(row.target_id, Number(row.weekly));
  return out;
}

export async function commitWizard(
  preview: WizardPreview,
): Promise<CommitResult> {
  // 0.17.6 — categories.tenant_id may be NULL (system-seeded defaults)
  // OR the tenant's own. We want either match.
  // 0.21.x — extended with the PAYCHECK_RECURRING_CATEGORIES so the
  // wizard seeds the same set of recurring spend rows the monthly
  // budget does (Parking / Transit / Taxi / Restaurants / Fast
  // Food / Coffee Shops / Food Delivery).
  const wanted = [
    'groceries',
    'gas & fuel',
    'tolls',
    'miscellaneous',
    'savings',
    ...PAYCHECK_RECURRING_CATEGORIES.map((n) => n.toLowerCase()),
  ];
  const catLookup = await pool.query<{ name: string; id: string }>(
    `SELECT DISTINCT ON (lower(name)) lower(name) AS name, id FROM categories
      WHERE lower(name) = ANY($2::text[])
        AND (tenant_id = $1 OR tenant_id IS NULL)
      ORDER BY lower(name), tenant_id NULLS LAST`,
    [preview.tenantId, wanted],
  );
  const byName = new Map(catLookup.rows.map((r) => [r.name, r.id]));
  const groceriesCat = byName.get('groceries') ?? null;
  const fuelCat = byName.get('gas & fuel') ?? null;
  const tollsCat = byName.get('tolls') ?? null;
  const miscCat = byName.get('miscellaneous') ?? null;
  const savingsCat = byName.get('savings') ?? null;

  // 0.21.x — recurring-spend category seeding (parking, transit,
  // restaurants, etc.). Weekly trailing average per category,
  // scaled to each period's day count below.
  const recurringCatIds = PAYCHECK_RECURRING_CATEGORIES.map(
    (n) => byName.get(n.toLowerCase()),
  ).filter((id): id is string => Boolean(id));
  const recurringWeekly = await weeklyRecurringByCategory(
    preview.tenantId,
    preview.accountIds && preview.accountIds.length > 0
      ? preview.accountIds
      : null,
    recurringCatIds,
  );

  // 0.17.16 — every wizard run creates its plan row first. The
  // per-period `budgets` rows then carry plan_id so the API
  // layer can render one Paycheck-to-Paycheck card per plan.
  // Validate account uniqueness up front so we don't insert a
  // plan only to fail on a downstream constraint.
  // 0.17.22 — also stamps savings_account_id on the plan.
  const scope = preview.accountIds && preview.accountIds.length > 0
    ? preview.accountIds
    : [];
  await ensureAccountsUnclaimed(preview.tenantId, scope);
  const planInsert = await query<{ id: string }>(
    `INSERT INTO budget_plans
       (tenant_id, name, period_type, anchor_date, account_ids, savings_account_id)
     VALUES ($1, $2, $3, $4::date, $5::uuid[], $6)
     RETURNING id`,
    [
      preview.tenantId,
      preview.name,
      preview.periodType,
      preview.anchor,
      scope,
      (preview as { savingsAccountId?: string | null }).savingsAccountId ?? null,
    ],
  );
  const planId = planInsert.rows[0]!.id;

  let created = 0;
  let skipped = 0;
  const perPeriod: Array<{ index: number; created: number; skipped: number }> = [];

  for (const p of preview.periods) {
    let cCreated = 0;
    let cSkipped = 0;
    // 0.21.x — paycheck plan seeds at the parent-category level
    // using whatever lives in the preview's `recurring` array.
    // The preview already honors per-period overrides + the
    // per-run "disabled" set the user toggled in the wizard, so
    // commit just iterates and inserts. miscCat + savingsCat are
    // user-driven inputs that stay separate.
    const editableInputs: Array<{
      catId: string | null;
      amount: number;
      note: string | null;
    }> = [
      // The three explicit AutoMagic categories. The route still
      // accepts groceriesOverrideCents / fuelOverrideCents /
      // tollsOverrideCents and the preview still computes
      // p.groceriesCents / p.fuelCents / p.tollsCents from them, so
      // commit MUST seed these rows — a 0.21.x refactor dropped them
      // here (voiding the cat ids), which silently discarded the
      // user's grocery/fuel/toll budget overrides. They go first so
      // that if a recurring-spend entry later resolves to the same
      // category in the same period, the dup-check below keeps the
      // explicit override (inserted first) and skips the duplicate.
      { catId: groceriesCat, amount: p.groceriesCents, note: null },
      { catId: fuelCat, amount: p.fuelCents, note: null },
      { catId: tollsCat, amount: p.tollsCents, note: null },
      { catId: miscCat, amount: p.miscCents, note: p.miscNote || null },
      { catId: savingsCat, amount: p.savingsCents, note: null },
    ];
    // recurringCatIds / recurringWeekly resolved above are kept
    // for back-compat but no longer iterated — commit reads the
    // preview's `recurring` array directly so user overrides /
    // disabled flags carry through.
    void recurringCatIds;
    void recurringWeekly;
    for (const r of p.recurring) {
      if (r.amount_cents <= 0) continue;
      editableInputs.push({
        catId: r.category_id,
        amount: r.amount_cents,
        note: null,
      });
    }
    for (const e of editableInputs) {
      if (e.amount <= 0 || e.catId === null) continue;
      // 0.17.16 — dup check is now plan-scoped. Each wizard run
      // creates a NEW plan_id, so this is effectively always
      // empty during a normal flow — kept defensively so a
      // future "re-commit into the same plan" path can land
      // idempotently.
      const existing = await pool.query(
        `SELECT 1 FROM budgets
          WHERE tenant_id = $1
            AND plan_id = $2
            AND period_month = $3::date
            AND category_id = $4
          LIMIT 1`,
        [preview.tenantId, planId, p.start, e.catId],
      );
      if (existing.rowCount! > 0) {
        cSkipped++;
        continue;
      }
      // 0.17.11 — store the wizard's account scope on each row
      // (kept for the actuals route's legacy lookup path; the
      // plan also carries the same accounts on `account_ids`).
      // 0.17.16 — stamp plan_id so the row belongs to its plan.
      const rowScope =
        preview.accountIds && preview.accountIds.length > 0
          ? preview.accountIds
          : null;
      await query(
        `INSERT INTO budgets (tenant_id, plan_id, period_month, period_type, category_id, amount_cents, note, included_account_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[])`,
        [preview.tenantId, planId, p.start, preview.periodType, e.catId, e.amount, e.note, rowScope],
      );
      cCreated++;
    }

    for (const bill of p.bills) {
      if (bill.amount_cents <= 0) continue;
      const existing = await pool.query(
        `SELECT 1 FROM budgets
          WHERE tenant_id = $1
            AND plan_id = $2
            AND period_month = $3::date
            AND bill_id = $4
          LIMIT 1`,
        [preview.tenantId, planId, p.start, bill.id],
      );
      if (existing.rowCount! > 0) {
        cSkipped++;
        continue;
      }
      const rowScope =
        preview.accountIds && preview.accountIds.length > 0
          ? preview.accountIds
          : null;
      await query(
        `INSERT INTO budgets (tenant_id, plan_id, period_month, period_type, bill_id, amount_cents, included_account_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[])`,
        [preview.tenantId, planId, p.start, preview.periodType, bill.id, bill.amount_cents, rowScope],
      );
      cCreated++;
    }

    perPeriod.push({ index: p.index, created: cCreated, skipped: cSkipped });
    created += cCreated;
    skipped += cSkipped;
  }

  return { planId, created, skipped, perPeriod };
}
