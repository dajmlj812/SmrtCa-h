import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { requireTenant } from '../auth/rbac.js';
import {
  analyzeAllocation,
  analyzeFees,
  monteCarloProjection,
  type AssetClass,
  type HoldingForAnalysis,
} from '../domain/investment-analysis.js';
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
}
