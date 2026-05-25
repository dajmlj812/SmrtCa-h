import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { requireTenant } from '../auth/rbac.js';
import {
  computePayoffPlan,
  type PayoffAccountInput,
} from '../domain/debt-payoff.js';

/**
 * 0.18.6 — POST /api/debt/payoff
 *
 * Body shape:
 *   {
 *     extraCents: number,         // applied each month above minimums
 *     overrides?: {
 *       [accountId]: { aprPercent?, minPaymentCents? }
 *     }
 *   }
 *
 * Loads every loan + credit_card account for the caller's tenant
 * (positive-magnitude only — accounts with $0 outstanding aren't
 * debt) and computes both snowball + avalanche plans. Overrides
 * let the user model "what if I bump the minimum?" without
 * persisting — useful for projection-only exploration.
 */
export async function debtPayoffRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: {
      extraCents?: unknown;
      overrides?: Record<
        string,
        { aprPercent?: number; minPaymentCents?: number }
      >;
    };
  }>('/api/debt/payoff', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const extraRaw = req.body?.extraCents;
    const extra =
      typeof extraRaw === 'number' ? extraRaw : Number(extraRaw ?? 0);
    if (!Number.isInteger(extra) || extra < 0) {
      return reply
        .code(400)
        .send({ error: 'extraCents must be a non-negative integer' });
    }

    // Loan / credit_card balances are typically stored as negative
    // (it's money you owe); we take magnitudes for the calculator.
    const rows = await query<{
      id: string;
      name: string;
      type: string;
      balance_cents: string;
      interest_rate_apr: string | null;
      min_payment_cents: string | null;
    }>(
      `SELECT a.id, a.name, a.type,
              (a.opening_balance_cents
                + COALESCE(SUM(t.amount_cents) FILTER (
                    WHERE a.opening_balance_date IS NULL
                       OR t.txn_date >= a.opening_balance_date
                  ), 0))::bigint AS balance_cents,
              a.interest_rate_apr::text AS interest_rate_apr,
              a.min_payment_cents::text AS min_payment_cents
         FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.id
        WHERE a.tenant_id = $1
          AND a.type IN ('loan','credit_card')
     GROUP BY a.id`,
      [tenantId],
    );

    const overrides = req.body?.overrides ?? {};
    const inputs: PayoffAccountInput[] = [];
    const missingData: Array<{ id: string; name: string; missing: string[] }> =
      [];
    for (const r of rows.rows) {
      const balance = Math.abs(Number(r.balance_cents));
      if (balance === 0) continue;
      const ov = overrides[r.id] ?? {};
      const apr =
        ov.aprPercent !== undefined
          ? ov.aprPercent
          : r.interest_rate_apr !== null
            ? Number(r.interest_rate_apr)
            : NaN;
      const min =
        ov.minPaymentCents !== undefined
          ? ov.minPaymentCents
          : r.min_payment_cents !== null
            ? Number(r.min_payment_cents)
            : NaN;
      const missing: string[] = [];
      if (!Number.isFinite(apr)) missing.push('apr');
      if (!Number.isFinite(min) || min <= 0) missing.push('min_payment');
      if (missing.length > 0) {
        missingData.push({ id: r.id, name: r.name, missing });
        continue;
      }
      inputs.push({
        id: r.id,
        name: r.name,
        balanceCents: balance,
        aprPercent: apr,
        minPaymentCents: min,
      });
    }

    if (inputs.length === 0) {
      return {
        accounts: [],
        snowball: null,
        avalanche: null,
        missing_data: missingData,
      };
    }

    const snowball = computePayoffPlan(inputs, 'snowball', extra);
    const avalanche = computePayoffPlan(inputs, 'avalanche', extra);
    return {
      accounts: inputs.map((a) => ({
        id: a.id,
        name: a.name,
        balance_cents: a.balanceCents,
        apr_percent: a.aprPercent,
        min_payment_cents: a.minPaymentCents,
      })),
      snowball,
      avalanche,
      missing_data: missingData,
    };
  });
}
