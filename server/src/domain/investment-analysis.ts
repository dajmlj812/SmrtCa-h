/**
 * 0.19.3 — Investment-analysis primitives.
 *
 * Three Empower-class analyses run on the existing `holdings` table:
 *
 *   1. analyzeFees — portfolio fee drag + 30-year compounded
 *      opportunity cost.
 *   2. analyzeAllocation — sum of holding value by asset class with
 *      derived-fallback for NULL classes, plus optional deviation
 *      from a target.
 *   3. monteCarloProjection — N-trial simulation around a baseline
 *      annual return ± stddev, returns the percentile fan (10th /
 *      50th / 90th) for the existing retirement-projection chart.
 *
 * Pure functions — no DB access from this module. The route layer
 * fetches holdings + projection inputs and hands them in. Keeping
 * compute side-effect-free makes the math unit-testable and lets
 * us reuse the simulator for "what-if" scenario tools later.
 */

export type AssetClass = 'stocks' | 'bonds' | 'cash' | 'alts' | 'real_estate';
const ASSET_CLASSES: readonly AssetClass[] = [
  'stocks',
  'bonds',
  'cash',
  'alts',
  'real_estate',
] as const;

export interface HoldingForAnalysis {
  id: string;
  symbol: string | null;
  name: string;
  asset_type: string;
  /** quantity × last_price_cents — pre-computed by the route. */
  value_cents: number;
  expense_ratio: number | null;
  asset_class: AssetClass | null;
}

// ── Fee analyzer ──────────────────────────────────────────

export interface FeeAnalysis {
  /** Total current value across all holdings (cents). */
  total_value_cents: number;
  /** Sum of value × expense_ratio for every holding with a known ER (cents/year). */
  annual_fee_cents: number;
  /** Same, but as a portfolio-wide weighted-average ER (% per year). */
  weighted_avg_expense_ratio_pct: number;
  /** Cents that would have remained had fees been zero, after 30 years of compounding at 7% nominal. */
  thirty_year_opportunity_cost_cents: number;
  /** Top contributors to the fee drag (up to 5 holdings, sorted by annual fee). */
  top_fee_drags: Array<{
    holding_id: string;
    symbol: string | null;
    name: string;
    value_cents: number;
    expense_ratio_pct: number;
    annual_fee_cents: number;
  }>;
  /** Count of holdings missing expense_ratio (i.e. excluded from the math). */
  unknown_ratio_count: number;
  unknown_ratio_value_cents: number;
}

/**
 * 30-year horizon, 7% nominal return is the standard "long-run
 * equity" assumption that lets users compare fee drag against an
 * apples-to-apples baseline. We model the difference between paying
 * the fee each year vs. not paying it as a perpetuity-equivalent
 * lump sum compounded out to 30 years. The simplification: assume
 * the fee comes out of the principal annually, so the "saved" fee
 * compounds at 7% for the remaining (30 - y) years where y is the
 * year it would have been paid.
 *
 * Formula for opportunity cost:
 *   OC = sum over y=1..30 of (annual_fee × (1.07)^(30 - y))
 *      = annual_fee × ((1.07^30 - 1) / 0.07)
 *
 * That's the future value of a 30-year annuity at 7%. ≈ 94.46 × the
 * annual fee.
 */
const HORIZON_YEARS = 30;
const ASSUMED_RETURN = 0.07;
const ANNUITY_FV_FACTOR =
  (Math.pow(1 + ASSUMED_RETURN, HORIZON_YEARS) - 1) / ASSUMED_RETURN;

export function analyzeFees(
  holdings: ReadonlyArray<HoldingForAnalysis>,
): FeeAnalysis {
  let totalValue = 0;
  let annualFee = 0;
  let knownRatioValue = 0;
  let unknownRatioValue = 0;
  let unknownRatioCount = 0;

  const perHolding: FeeAnalysis['top_fee_drags'] = [];
  for (const h of holdings) {
    totalValue += h.value_cents;
    if (h.expense_ratio === null) {
      unknownRatioCount += 1;
      unknownRatioValue += h.value_cents;
      continue;
    }
    knownRatioValue += h.value_cents;
    // expense_ratio is stored as a percent (e.g. 0.040 = 0.040%).
    const fee = (h.value_cents * h.expense_ratio) / 100;
    annualFee += fee;
    perHolding.push({
      holding_id: h.id,
      symbol: h.symbol,
      name: h.name,
      value_cents: h.value_cents,
      expense_ratio_pct: h.expense_ratio,
      annual_fee_cents: Math.round(fee),
    });
  }

  perHolding.sort((a, b) => b.annual_fee_cents - a.annual_fee_cents);
  const weightedAvg =
    knownRatioValue > 0 ? (annualFee / knownRatioValue) * 100 : 0;
  const opportunityCost = Math.round(annualFee * ANNUITY_FV_FACTOR);

  return {
    total_value_cents: totalValue,
    annual_fee_cents: Math.round(annualFee),
    weighted_avg_expense_ratio_pct: round3(weightedAvg),
    thirty_year_opportunity_cost_cents: opportunityCost,
    top_fee_drags: perHolding.slice(0, 5),
    unknown_ratio_count: unknownRatioCount,
    unknown_ratio_value_cents: unknownRatioValue,
  };
}

// ── Allocation analyzer ───────────────────────────────────

export interface AllocationBucket {
  asset_class: AssetClass;
  value_cents: number;
  pct: number;
  /** Target % from user prefs, or null if not configured. */
  target_pct: number | null;
  /** Actual - target, in percentage points. null if no target. */
  deviation_pp: number | null;
}

export interface AllocationAnalysis {
  total_value_cents: number;
  buckets: AllocationBucket[];
  /** Count of holdings with NULL asset_class that fell through to the asset_type fallback. */
  derived_class_count: number;
}

/** Fallback when asset_class is NULL: derive from asset_type. */
function deriveAssetClass(assetType: string): AssetClass {
  switch (assetType) {
    case 'bond':
      return 'bonds';
    case 'crypto':
    case 'commodity':
      return 'alts';
    case 'stock':
    case 'etf':
    case 'mutual_fund':
    case 'other':
    default:
      return 'stocks';
  }
}

export function analyzeAllocation(
  holdings: ReadonlyArray<HoldingForAnalysis>,
  targets?: Partial<Record<AssetClass, number>>,
): AllocationAnalysis {
  const totals = new Map<AssetClass, number>();
  let derivedCount = 0;
  let total = 0;
  for (const h of holdings) {
    const cls = h.asset_class ?? deriveAssetClass(h.asset_type);
    if (h.asset_class === null) derivedCount++;
    totals.set(cls, (totals.get(cls) ?? 0) + h.value_cents);
    total += h.value_cents;
  }
  const buckets: AllocationBucket[] = ASSET_CLASSES.map((cls) => {
    const v = totals.get(cls) ?? 0;
    const pct = total > 0 ? (v / total) * 100 : 0;
    const target = targets?.[cls] ?? null;
    return {
      asset_class: cls,
      value_cents: v,
      pct: round3(pct),
      target_pct: target,
      deviation_pp: target !== null ? round3(pct - target) : null,
    };
  });
  return {
    total_value_cents: total,
    buckets,
    derived_class_count: derivedCount,
  };
}

// ── Monte Carlo projection ────────────────────────────────

export interface MonteCarloInput {
  startingBalanceCents: number;
  monthlyContributionCents: number;
  /** Expected annual return, e.g. 0.07 for 7%. */
  annualReturnPct: number;
  /** Stddev of annual return, e.g. 0.15 for ±15pp (a typical equity-portfolio number). */
  annualStddevPct: number;
  /** Inflation deflator for the "real" view. */
  annualInflationPct: number;
  horizonYears: number;
  /** Number of independent trials. Default 5000 (sweet spot for stability vs. speed). */
  trials?: number;
  baseYear?: number;
}

export interface MonteCarloPoint {
  year: number;
  /** Percentile values in nominal cents. */
  p10_nominal_cents: number;
  p50_nominal_cents: number;
  p90_nominal_cents: number;
  /** Percentile values in real (inflation-adjusted) cents. */
  p10_real_cents: number;
  p50_real_cents: number;
  p90_real_cents: number;
}

export interface MonteCarloResult {
  trials: number;
  points: MonteCarloPoint[];
  /** Probability the final-year balance >= target (when target supplied). */
  prob_meet_target?: number;
}

/**
 * Run a Monte Carlo simulation over the projection model. Each trial
 * walks the same monthly compound loop as computeProjection() but
 * draws a fresh annual return from N(mean, stddev) at the start of
 * each year, then derives the corresponding monthly return.
 *
 * Performance: trials × horizon × 12 = 5000 × 30 × 12 = 1.8M
 * iterations. ~50ms in V8. The Box-Muller transform produces two
 * independent N(0,1) draws per call, so we generate pairs.
 *
 * Why annual draws (rather than monthly): an equity portfolio's
 * "annual return" stddev (~15%) isn't well-modeled by 12
 * independent monthly draws — the autocorrelation is real. Drawing
 * once per year and applying the implied monthly rate keeps the
 * statistic honest.
 */
export function monteCarloProjection(
  input: MonteCarloInput,
  targetCents?: number,
): MonteCarloResult {
  const trials = input.trials ?? 5000;
  const baseYear = input.baseYear ?? new Date().getUTCFullYear();
  const horizon = input.horizonYears;
  const mean = input.annualReturnPct / 100;
  const stddev = input.annualStddevPct / 100;
  const inflation = input.annualInflationPct / 100;

  // Per-year balance samples: balances[year][trial].
  // Allocate flat for cache friendliness.
  const balances: number[][] = [];
  for (let y = 0; y <= horizon; y++) balances.push(new Array(trials));

  // Box-Muller pair generator.
  let cachedNormal: number | null = null;
  const normal = (): number => {
    if (cachedNormal !== null) {
      const n = cachedNormal;
      cachedNormal = null;
      return n;
    }
    let u1 = 0;
    let u2 = 0;
    while (u1 === 0) u1 = Math.random();
    while (u2 === 0) u2 = Math.random();
    const mag = Math.sqrt(-2.0 * Math.log(u1));
    const z0 = mag * Math.cos(2.0 * Math.PI * u2);
    const z1 = mag * Math.sin(2.0 * Math.PI * u2);
    cachedNormal = z1;
    return z0;
  };

  for (let t = 0; t < trials; t++) {
    let balance = input.startingBalanceCents;
    balances[0]![t] = balance;
    for (let y = 1; y <= horizon; y++) {
      const annualReturn = mean + stddev * normal();
      const monthlyReturn = Math.pow(1 + annualReturn, 1 / 12) - 1;
      for (let m = 0; m < 12; m++) {
        balance += input.monthlyContributionCents;
        balance *= 1 + monthlyReturn;
      }
      balances[y]![t] = balance;
    }
  }

  // Sort per-year and extract percentiles.
  const percentile = (sorted: number[], p: number): number => {
    const idx = Math.floor((p / 100) * (sorted.length - 1));
    return sorted[idx]!;
  };
  const points: MonteCarloPoint[] = [];
  for (let y = 0; y <= horizon; y++) {
    const row = balances[y]!.slice().sort((a, b) => a - b);
    const inflFactor = Math.pow(1 + inflation, y);
    const p10 = percentile(row, 10);
    const p50 = percentile(row, 50);
    const p90 = percentile(row, 90);
    points.push({
      year: baseYear + y,
      p10_nominal_cents: Math.round(p10),
      p50_nominal_cents: Math.round(p50),
      p90_nominal_cents: Math.round(p90),
      p10_real_cents: Math.round(p10 / inflFactor),
      p50_real_cents: Math.round(p50 / inflFactor),
      p90_real_cents: Math.round(p90 / inflFactor),
    });
  }

  // Optional success-probability: share of trials whose final-year
  // balance meets or exceeds a target.
  let probMeetTarget: number | undefined;
  if (typeof targetCents === 'number') {
    const finalRow = balances[horizon]!;
    const hits = finalRow.reduce(
      (n, v) => (v >= targetCents ? n + 1 : n),
      0,
    );
    probMeetTarget = round3(hits / trials);
  }

  return {
    trials,
    points,
    ...(probMeetTarget !== undefined ? { prob_meet_target: probMeetTarget } : {}),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
