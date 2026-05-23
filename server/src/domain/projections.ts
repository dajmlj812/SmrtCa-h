/**
 * Retirement / long-term goal projections.
 *
 * Math is monthly-compound on the annual return rate. For each month:
 *   1. add the monthly contribution
 *   2. apply the monthly return (= (1 + annual_return/100)^(1/12) - 1)
 *
 * At the end of each year we emit a series point with both the nominal
 * (today's dollars) and the real-terms (today's dollars deflated by
 * the inflation rate) projected balance. The chart can show either or
 * both.
 *
 * Edge cases:
 *  - 0% return is allowed (savings account).
 *  - Negative annual return is permitted (loss scenario).
 *  - Inflation defaults to 0; when set, real = nominal / (1+infl/100)^year.
 *  - We clamp horizon_years to <= 100 in the schema; computation runs
 *    O(months) so 100 years = 1200 iterations, fast.
 */

export interface ProjectionInput {
  startingBalanceCents: number;
  monthlyContributionCents: number;
  annualReturnPct: number;
  annualInflationPct: number;
  horizonYears: number;
  /** Year that month 0 sits in. Used for the X axis labels. */
  baseYear?: number;
}

export interface ProjectionPoint {
  year: number;
  nominal_cents: number;
  real_cents: number;
}

export function computeProjection(input: ProjectionInput): ProjectionPoint[] {
  const monthlyReturn = Math.pow(1 + input.annualReturnPct / 100, 1 / 12) - 1;
  const baseYear = input.baseYear ?? new Date().getUTCFullYear();
  const series: ProjectionPoint[] = [];
  // Year 0 = starting point.
  series.push({
    year: baseYear,
    nominal_cents: input.startingBalanceCents,
    real_cents: input.startingBalanceCents,
  });
  let balance = input.startingBalanceCents;
  for (let y = 1; y <= input.horizonYears; y++) {
    for (let m = 0; m < 12; m++) {
      balance += input.monthlyContributionCents;
      balance = balance * (1 + monthlyReturn);
    }
    const inflationFactor = Math.pow(1 + input.annualInflationPct / 100, y);
    series.push({
      year: baseYear + y,
      nominal_cents: Math.round(balance),
      real_cents: Math.round(balance / inflationFactor),
    });
  }
  return series;
}
