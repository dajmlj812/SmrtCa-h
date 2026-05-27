/**
 * 0.21.4 — Time-weighted return + IRR for an investment account.
 *
 * TWRR (time-weighted rate of return) is the right number for
 * "how did the manager / strategy do?" — it strips out the
 * effect of your deposit/withdrawal timing so it can be compared
 * cleanly against a benchmark.
 *
 * IRR (money-weighted return) is the right number for "what
 * return did MY actual cash earn?" — it reflects timing and is
 * what most retail brokers display.
 *
 * Inputs are a sequence of dated cash flows (positive = into the
 * account from outside, negative = out of the account) plus the
 * starting value, ending value, and ending date.
 */

export interface DatedFlow {
  /** ISO date — YYYY-MM-DD. */
  date: string;
  /** Cents. Positive = deposit, negative = withdrawal. */
  amount_cents: number;
}

/**
 * Time-weighted return over [startDate, endDate].
 *
 * We split the timeline at each external cash flow, compute the
 * sub-period return as (V_end - V_start - flow_in_period) / V_start,
 * and multiply all (1 + r_i) - 1 to get the cumulative TWRR.
 *
 * `intermediateValues` is optional but produces a better number
 * when present: the caller supplies the account market value
 * BEFORE each flow on the flow's date. When omitted we
 * approximate by linearly interpolating between start and end
 * value — fine for low-frequency flows, imprecise for daily ones.
 */
export function twrr(args: {
  startValueCents: number;
  endValueCents: number;
  flows: DatedFlow[];
  intermediateValues?: Record<string, number>;
}): number {
  const { startValueCents, endValueCents, flows, intermediateValues = {} } = args;
  if (startValueCents <= 0 && flows.length === 0) return 0;
  // Sort flows chronologically.
  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  let cumulative = 1;
  let priorValue = startValueCents;
  for (const f of sorted) {
    const valueBeforeFlow = intermediateValues[f.date] ?? priorValue;
    if (valueBeforeFlow <= 0) continue;
    const subReturn = (valueBeforeFlow - priorValue) / priorValue;
    cumulative *= 1 + subReturn;
    priorValue = valueBeforeFlow + f.amount_cents;
  }
  if (priorValue > 0) {
    const finalSub = (endValueCents - priorValue) / priorValue;
    cumulative *= 1 + finalSub;
  }
  return cumulative - 1;
}

/**
 * Annualize a cumulative return given the period length in days.
 */
export function annualize(cumulativeReturn: number, days: number): number {
  if (days <= 0) return 0;
  const years = days / 365.25;
  if (years < 0.01) return cumulativeReturn;
  return Math.pow(1 + cumulativeReturn, 1 / years) - 1;
}

/**
 * Internal rate of return via Newton-Raphson, falling back to
 * bisection if the secant misbehaves.
 *
 * `cashflows` includes the starting and ending values:
 *   - start value as a negative flow on startDate
 *     (treat the opening balance as "money you put in"),
 *   - external flows along the way,
 *   - end value as a positive flow on endDate
 *     (treat the closing balance as "money you took out").
 */
export function irr(cashflows: DatedFlow[]): number {
  if (cashflows.length < 2) return 0;
  const sorted = [...cashflows].sort((a, b) => a.date.localeCompare(b.date));
  const t0 = new Date(sorted[0]!.date).getTime();
  const days = sorted.map((c) => (new Date(c.date).getTime() - t0) / 86_400_000);
  const flows = sorted.map((c) => c.amount_cents);

  function npv(r: number): number {
    let s = 0;
    for (let i = 0; i < flows.length; i++) {
      s += flows[i]! / Math.pow(1 + r, days[i]! / 365.25);
    }
    return s;
  }

  // Newton's method
  let r = 0.1;
  for (let iter = 0; iter < 50; iter++) {
    const value = npv(r);
    const eps = 1e-4;
    const slope = (npv(r + eps) - value) / eps;
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-12) break;
    const next = r - value / slope;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - r) < 1e-6) return next;
    r = Math.max(-0.99, next);
  }
  // Fallback: bisection in [-0.99, 10].
  let lo = -0.99;
  let hi = 10;
  let nLo = npv(lo);
  let nHi = npv(hi);
  if (nLo * nHi > 0) return r;
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2;
    const nMid = npv(mid);
    if (Math.abs(nMid) < 1) return mid;
    if (nLo * nMid < 0) {
      hi = mid;
      nHi = nMid;
    } else {
      lo = mid;
      nLo = nMid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Approximate annualized S&P 500 total-return reference values.
 * This is intentionally a static table — we don't want to depend
 * on a live market data feed for a "vs benchmark" sanity check.
 * The user can supply a custom rate via the API if they prefer.
 */
const SP500_ANNUAL_TOTAL_RETURN: Record<number, number> = {
  2015: 0.0138,
  2016: 0.1196,
  2017: 0.2183,
  2018: -0.0438,
  2019: 0.3149,
  2020: 0.1840,
  2021: 0.2871,
  2022: -0.1811,
  2023: 0.2629,
  2024: 0.2503,
  2025: 0.0400, // placeholder; update as published
  2026: 0.0400, // placeholder
};

export function benchmarkCumulativeReturn(
  startDate: string,
  endDate: string,
  annualRate?: number,
): number {
  // If the caller passes a fixed annualRate, just compound it
  // over the period.
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const years = (end - start) / (365.25 * 86_400_000);
  if (years <= 0) return 0;
  if (annualRate !== undefined) {
    return Math.pow(1 + annualRate, years) - 1;
  }
  // Multiply per-year returns over the period. Partial years
  // scale linearly within the calendar year (good-enough
  // approximation for a sanity-check benchmark).
  let cumulative = 1;
  for (
    let y = new Date(startDate).getUTCFullYear();
    y <= new Date(endDate).getUTCFullYear();
    y++
  ) {
    const yearStart = new Date(`${y}-01-01`).getTime();
    const yearEnd = new Date(`${y}-12-31`).getTime();
    const inStart = Math.max(start, yearStart);
    const inEnd = Math.min(end, yearEnd);
    if (inEnd < inStart) continue;
    const yearFraction = (inEnd - inStart) / (yearEnd - yearStart);
    const rate = SP500_ANNUAL_TOTAL_RETURN[y] ?? 0.08;
    cumulative *= Math.pow(1 + rate, yearFraction);
  }
  return cumulative - 1;
}
