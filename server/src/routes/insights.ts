import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { assertAccountInTenant, requireTenant } from '../auth/rbac.js';

interface InsightsQuery {
  start?: string;
  end?: string;
  months?: string;
  accountId?: string;
}

function isYmd(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Insights endpoints (Phase 4).
 *
 * 0.14.2 — every aggregation is now tenant-scoped via an accounts
 * join. Pre-0.14.2 these routes happily summed every tenant's
 * transactions, so a child on Tenant A could see how much Tenant B
 * spent at Starbucks last month. When the caller passes an
 * `accountId`, we verify it belongs to their tenant before using it
 * (so a probe with another tenant's account UUID 404s instead of
 * silently returning empty results).
 *
 * Every aggregation also excludes transfers between own accounts —
 * those are internal moves, not flow in or out of the household.
 */
export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  // Spending by category over a date range.
  app.get<{ Querystring: InsightsQuery }>(
    '/api/insights/spending-by-category',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const { start, end, accountId } = req.query;
      if (start && !isYmd(start)) {
        return reply.code(400).send({ error: 'start must be YYYY-MM-DD' });
      }
      if (end && !isYmd(end)) {
        return reply.code(400).send({ error: 'end must be YYYY-MM-DD' });
      }
      const accountIdParam = accountId?.trim() || null;
      if (accountIdParam) {
        if (!isUuid(accountIdParam)) {
          return reply.code(400).send({ error: 'Invalid accountId' });
        }
        const ok = await assertAccountInTenant(tenantId, accountIdParam);
        if (!ok) return reply.code(404).send({ error: 'Account not found' });
      }

      const now = new Date();
      const defaultStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
      const defaultEnd = now.toISOString().slice(0, 10);
      const startParam = start ?? defaultStart;
      const endParam = end ?? defaultEnd;

      // Spending uses transaction_category_lines so split transactions
      // contribute per-category amounts instead of dumping everything
      // into the transaction-level category. The accounts join is the
      // tenant gate — without it, a tenant would see every household's
      // per-category spending.
      const result = await query(
        `SELECT l.category_id,
                c.name      AS category_name,
                c.parent_id AS parent_id,
                p.name      AS parent_name,
                SUM(-l.amount_cents)::bigint AS total_cents,
                COUNT(DISTINCT l.transaction_id)::int AS transaction_count
           FROM transaction_category_lines l
           JOIN accounts a ON a.id = l.account_id
      LEFT JOIN categories c ON c.id = l.category_id
      LEFT JOIN categories p ON p.id = c.parent_id
          WHERE a.tenant_id = $1
            AND l.amount_cents < 0
            AND l.transfer_group_id IS NULL
            AND l.txn_date >= $2::date
            AND l.txn_date <= $3::date
            AND ($4::uuid IS NULL OR l.account_id = $4)
       GROUP BY l.category_id, c.name, c.parent_id, p.name
       ORDER BY total_cents DESC`,
        [tenantId, startParam, endParam, accountIdParam],
      );
      return {
        start: startParam,
        end: endParam,
        rows: result.rows,
      };
    },
  );

  // Monthly income vs expense for the last N months (default 12).
  app.get<{ Querystring: InsightsQuery }>(
    '/api/insights/income-expense',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const months = Math.min(
        Math.max(Number(req.query.months) || 12, 1),
        60,
      );
      const accountIdParam = req.query.accountId?.trim() || null;
      if (accountIdParam) {
        if (!isUuid(accountIdParam)) {
          return reply.code(400).send({ error: 'Invalid accountId' });
        }
        const ok = await assertAccountInTenant(tenantId, accountIdParam);
        if (!ok) return reply.code(404).send({ error: 'Account not found' });
      }

      const result = await query(
        `WITH series AS (
           SELECT generate_series(
             date_trunc('month', now())::date - make_interval(months => $1::int - 1),
             date_trunc('month', now())::date,
             interval '1 month'
           )::date AS month_start
         )
         SELECT to_char(s.month_start, 'YYYY-MM') AS month,
                COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END), 0)::bigint AS income_cents,
                COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END), 0)::bigint AS expense_cents
           FROM series s
      LEFT JOIN transactions t
             ON date_trunc('month', t.txn_date)::date = s.month_start
            AND t.transfer_group_id IS NULL
            AND EXISTS (
              SELECT 1 FROM accounts a
               WHERE a.id = t.account_id
                 AND a.tenant_id = $2
                 AND ($3::uuid IS NULL OR a.id = $3)
            )
       GROUP BY s.month_start
       ORDER BY s.month_start`,
        [months, tenantId, accountIdParam],
      );
      return { months, rows: result.rows };
    },
  );

  // Net worth at the end of each month for the last N months.
  app.get<{ Querystring: InsightsQuery }>(
    '/api/insights/net-worth-over-time',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const months = Math.min(
        Math.max(Number(req.query.months) || 12, 1),
        60,
      );

      // Tenant-scoped on accounts AND holdings — pre-0.14.2 the
      // holdings_value subquery summed every tenant's investment
      // positions, so anyone with a session saw the household-wide
      // crypto+stock total of every other household.
      const result = await query(
        `WITH series AS (
           SELECT generate_series(
             date_trunc('month', now())::date - make_interval(months => $1::int - 1),
             date_trunc('month', now())::date,
             interval '1 month'
           )::date AS month_start
         ),
         month_ends AS (
           SELECT month_start,
                  (month_start + interval '1 month' - interval '1 day')::date AS month_end
             FROM series
         ),
         holdings_value AS (
           SELECT COALESCE(SUM(h.quantity * h.last_price_cents), 0)::bigint AS total
             FROM holdings h
             JOIN accounts a ON a.id = h.account_id
            WHERE a.tenant_id = $2
         )
         SELECT to_char(me.month_start, 'YYYY-MM') AS month,
                (COALESCE(SUM(
                  a.opening_balance_cents +
                  COALESCE((
                    SELECT SUM(t.amount_cents)
                      FROM transactions t
                     WHERE t.account_id = a.id
                       AND (a.opening_balance_date IS NULL
                            OR t.txn_date >= a.opening_balance_date)
                       AND t.txn_date <= me.month_end
                  ), 0)
                ), 0)
                + (SELECT total FROM holdings_value))::bigint AS net_worth_cents
           FROM month_ends me
     CROSS JOIN accounts a
          WHERE a.tenant_id = $2
       GROUP BY me.month_start
       ORDER BY me.month_start`,
        [months, tenantId],
      );
      return { months, rows: result.rows };
    },
  );
}
