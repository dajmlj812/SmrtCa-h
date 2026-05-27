import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';
import { requireTenant } from '../auth/rbac.js';
import {
  analyzeAllocation,
  analyzeFees,
  monteCarloProjection,
  type AssetClass,
  type HoldingForAnalysis,
} from '../domain/investment-analysis.js';
import {
  annualize,
  benchmarkCumulativeReturn,
  irr,
  twrr,
  type DatedFlow,
} from '../domain/investment-performance.js';
import { isUuid } from '../util.js';

/**
 * 0.19.3 — Empower-class investment analysis endpoints.
 *
 *   GET  /api/investments/analysis
 *     Fee analyzer + asset allocation across every holding in the
 *     tenant. Optional ?targets=stocks:60,bonds:40 query for
 *     deviation calc. ?targets is intentionally simple (no DB) —
 *     a per-user target table can come later if usage warrants.
 *
 *   POST /api/projections/:id/monte-carlo
 *     Runs N trials of the existing retirement projection with
 *     random returns drawn from N(mean, stddev), returns the
 *     percentile fan (10th/50th/90th) per year. Body controls
 *     stddev + trial count. Long-running for big numbers — capped
 *     server-side at 20k trials.
 */

const VALID_CLASSES: ReadonlyArray<AssetClass> = [
  'stocks',
  'bonds',
  'cash',
  'alts',
  'real_estate',
];

function parseTargets(q: string | undefined): Partial<Record<AssetClass, number>> | undefined {
  if (!q) return undefined;
  const out: Partial<Record<AssetClass, number>> = {};
  for (const part of q.split(',')) {
    const [cls, val] = part.split(':');
    if (!cls || !val) continue;
    if (!(VALID_CLASSES as readonly string[]).includes(cls)) continue;
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0 || n > 100) continue;
    out[cls as AssetClass] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function investmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { targets?: string } }>(
    '/api/investments/analysis',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const targets = parseTargets(req.query.targets);

      // Fetch every holding in the tenant + pre-compute value.
      const r = await query<{
        id: string;
        symbol: string | null;
        name: string;
        asset_type: string;
        value_cents: string;
        expense_ratio: number | null;
        asset_class: string | null;
      }>(
        `SELECT h.id, h.symbol, h.name, h.asset_type,
                (h.quantity * h.last_price_cents)::bigint AS value_cents,
                h.expense_ratio::float8 AS expense_ratio,
                h.asset_class
           FROM holdings h
           JOIN accounts a ON a.id = h.account_id
          WHERE a.tenant_id = $1`,
        [tenantId],
      );
      const holdings: HoldingForAnalysis[] = r.rows.map((row) => ({
        id: row.id,
        symbol: row.symbol,
        name: row.name,
        asset_type: row.asset_type,
        value_cents: Number(row.value_cents),
        expense_ratio: row.expense_ratio,
        asset_class:
          row.asset_class &&
          (VALID_CLASSES as readonly string[]).includes(row.asset_class)
            ? (row.asset_class as AssetClass)
            : null,
      }));

      return {
        fees: analyzeFees(holdings),
        allocation: analyzeAllocation(holdings, targets),
        holding_count: holdings.length,
      };
    },
  );

  // Monte Carlo over an existing retirement projection.
  app.post<{
    Params: { id: string };
    Body: { stddevPct?: unknown; trials?: unknown };
  }>('/api/projections/:id/monte-carlo', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isUuid(req.params.id)) {
      return reply.code(400).send({ error: 'Invalid projection id' });
    }
    const body = req.body ?? {};
    const stddev = Number(body.stddevPct ?? 15);
    if (!Number.isFinite(stddev) || stddev < 0 || stddev > 100) {
      return reply.code(400).send({ error: 'stddevPct must be 0-100' });
    }
    const trials = Math.min(
      Math.max(Math.floor(Number(body.trials ?? 5000)), 100),
      20000,
    );

    const p = await query<{
      starting_balance_cents: string;
      monthly_contribution_cents: string;
      annual_return_pct: string;
      annual_inflation_pct: string;
      horizon_years: number;
      target_amount_cents: string | null;
    }>(
      `SELECT starting_balance_cents, monthly_contribution_cents,
              annual_return_pct, annual_inflation_pct, horizon_years,
              target_amount_cents
         FROM retirement_projections
        WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId],
    );
    if (p.rowCount === 0) {
      return reply.code(404).send({ error: 'Projection not found' });
    }
    const row = p.rows[0]!;
    const result = monteCarloProjection(
      {
        startingBalanceCents: Number(row.starting_balance_cents),
        monthlyContributionCents: Number(row.monthly_contribution_cents),
        annualReturnPct: Number(row.annual_return_pct),
        annualStddevPct: stddev,
        annualInflationPct: Number(row.annual_inflation_pct),
        horizonYears: row.horizon_years,
        trials,
      },
      row.target_amount_cents ? Number(row.target_amount_cents) : undefined,
    );
    return result;
  });

  // 0.21.4 — Investment performance (TWRR + IRR vs benchmark).
  //
  // Per-investment-account performance over a date range. Defaults
  // to the past year. Pulls deposits/withdrawals from transactions
  // on the account (excluding transfer pairs already handled by the
  // transfer logic) and the current portfolio value from
  // SUM(holdings.quantity * holdings.last_price_cents).
  app.get<{
    Querystring: { startDate?: string; endDate?: string; benchmarkRate?: string };
  }>('/api/investments/performance', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const today = new Date().toISOString().slice(0, 10);
    const endDate = req.query.endDate || today;
    const startDate =
      req.query.startDate ||
      new Date(new Date(endDate).getTime() - 365 * 86_400_000)
        .toISOString()
        .slice(0, 10);
    const benchmarkRate = req.query.benchmarkRate
      ? Number(req.query.benchmarkRate)
      : undefined;
    if (benchmarkRate !== undefined && !Number.isFinite(benchmarkRate)) {
      return reply.code(400).send({ error: 'benchmarkRate must be numeric' });
    }

    // List investment accounts for the tenant.
    const accounts = await pool.query<{
      id: string; name: string;
    }>(
      `SELECT a.id, a.name FROM accounts a
        WHERE a.tenant_id = $1
          AND a.type = 'investment'`,
      [tenantId],
    );
    if (accounts.rowCount === 0) {
      return {
        startDate, endDate, accounts: [],
        portfolio: emptyPerf(startDate, endDate, benchmarkRate),
      };
    }

    const perAccount: Array<{
      account_id: string;
      account_name: string;
      start_value_cents: number;
      end_value_cents: number;
      flows_in_cents: number;
      flows_out_cents: number;
      twrr_cumulative: number;
      twrr_annualized: number;
      irr_annualized: number;
      benchmark_cumulative: number;
      benchmark_annualized: number;
    }> = [];

    let portfolioStart = 0;
    let portfolioEnd = 0;
    const portfolioFlows: DatedFlow[] = [];

    for (const acct of accounts.rows) {
      // End value = current holdings value.
      const valR = await pool.query<{ v: string }>(
        `SELECT COALESCE(SUM(quantity * last_price_cents), 0)::bigint::text AS v
           FROM holdings WHERE account_id = $1`,
        [acct.id],
      );
      const endValue = Number(valR.rows[0]!.v);

      // Start value: end value minus all flows in the period minus
      // valuation drift. We approximate by treating the
      // beginning-of-period balance as 0 if we have no historical
      // snapshot. (Improving this requires daily holding snapshots
      // — left as a follow-up.)
      const startValR = await pool.query<{ v: string }>(
        `SELECT COALESCE(SUM(amount_cents), 0)::bigint::text AS v
           FROM transactions
          WHERE account_id = $1
            AND txn_date < $2`,
        [acct.id, startDate],
      );
      const cumulativeBeforeStart = Number(startValR.rows[0]!.v);
      const startValue = Math.max(0, cumulativeBeforeStart);

      // Flows during the period: external deposits (income flag)
      // and withdrawals on this account. We use absolute amount
      // sign convention: amount_cents > 0 means cash into the
      // account = deposit; < 0 means money out.
      const flowR = await pool.query<{ txn_date: string; amount_cents: string }>(
        `SELECT txn_date::text, amount_cents::text
           FROM transactions
          WHERE account_id = $1
            AND txn_date BETWEEN $2::date AND $3::date
          ORDER BY txn_date`,
        [acct.id, startDate, endDate],
      );
      const flows: DatedFlow[] = flowR.rows.map((r) => ({
        date: r.txn_date,
        amount_cents: Number(r.amount_cents),
      }));
      const flowsIn = flows
        .filter((f) => f.amount_cents > 0)
        .reduce((s, f) => s + f.amount_cents, 0);
      const flowsOut = flows
        .filter((f) => f.amount_cents < 0)
        .reduce((s, f) => s + f.amount_cents, 0);

      const cum = twrr({
        startValueCents: startValue,
        endValueCents: endValue,
        flows,
      });

      const days = Math.max(
        1,
        (new Date(endDate).getTime() - new Date(startDate).getTime()) /
          86_400_000,
      );
      const ann = annualize(cum, days);

      const irrFlows: DatedFlow[] = [
        { date: startDate, amount_cents: -startValue },
        ...flows,
        { date: endDate, amount_cents: endValue },
      ].filter((f) => f.amount_cents !== 0);
      const irrR = irrFlows.length >= 2 ? irr(irrFlows) : 0;

      const benchCum = benchmarkCumulativeReturn(startDate, endDate, benchmarkRate);
      const benchAnn = annualize(benchCum, days);

      perAccount.push({
        account_id: acct.id,
        account_name: acct.name,
        start_value_cents: startValue,
        end_value_cents: endValue,
        flows_in_cents: flowsIn,
        flows_out_cents: flowsOut,
        twrr_cumulative: cum,
        twrr_annualized: ann,
        irr_annualized: irrR,
        benchmark_cumulative: benchCum,
        benchmark_annualized: benchAnn,
      });

      portfolioStart += startValue;
      portfolioEnd += endValue;
      portfolioFlows.push(...flows);
    }

    const portfolioCum = twrr({
      startValueCents: portfolioStart,
      endValueCents: portfolioEnd,
      flows: portfolioFlows,
    });
    const days = Math.max(
      1,
      (new Date(endDate).getTime() - new Date(startDate).getTime()) /
        86_400_000,
    );
    const portfolioIrr =
      portfolioFlows.length > 0
        ? irr([
            { date: startDate, amount_cents: -portfolioStart },
            ...portfolioFlows,
            { date: endDate, amount_cents: portfolioEnd },
          ].filter((f) => f.amount_cents !== 0))
        : 0;
    const portfolioBench = benchmarkCumulativeReturn(startDate, endDate, benchmarkRate);

    return {
      startDate,
      endDate,
      accounts: perAccount,
      portfolio: {
        start_value_cents: portfolioStart,
        end_value_cents: portfolioEnd,
        twrr_cumulative: portfolioCum,
        twrr_annualized: annualize(portfolioCum, days),
        irr_annualized: portfolioIrr,
        benchmark_cumulative: portfolioBench,
        benchmark_annualized: annualize(portfolioBench, days),
      },
    };
  });
}

function emptyPerf(
  startDate: string,
  endDate: string,
  benchmarkRate: number | undefined,
) {
  const days = Math.max(
    1,
    (new Date(endDate).getTime() - new Date(startDate).getTime()) /
      86_400_000,
  );
  const benchCum = benchmarkCumulativeReturn(startDate, endDate, benchmarkRate);
  return {
    start_value_cents: 0,
    end_value_cents: 0,
    twrr_cumulative: 0,
    twrr_annualized: 0,
    irr_annualized: 0,
    benchmark_cumulative: benchCum,
    benchmark_annualized: annualize(benchCum, days),
  };
}
