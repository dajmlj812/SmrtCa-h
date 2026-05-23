import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';

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
 * Insights endpoints (Phase 4). Every aggregation that summarizes
 * "spending" or "income" excludes transfers between own accounts — those
 * are internal moves, not flow in or out of the household. Net worth is
 * unaffected because a transfer's debit and credit cancel each other.
 */
export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  // Spending by category over a date range.
  app.get<{ Querystring: InsightsQuery }>(
    '/api/insights/spending-by-category',
    async (req, reply) => {
      const { start, end, accountId } = req.query;
      if (start && !isYmd(start)) {
        return reply.code(400).send({ error: 'start must be YYYY-MM-DD' });
      }
      if (end && !isYmd(end)) {
        return reply.code(400).send({ error: 'end must be YYYY-MM-DD' });
      }
      const accountIdParam = accountId?.trim() || null;
      if (accountIdParam && !isUuid(accountIdParam)) {
        return reply.code(400).send({ error: 'Invalid accountId' });
      }

      // Default range: first-of-current-month → today.
      const now = new Date();
      const defaultStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
      const defaultEnd = now.toISOString().slice(0, 10);
      const startParam = start ?? defaultStart;
      const endParam = end ?? defaultEnd;

      // Spending uses transaction_category_lines so split transactions
      // contribute per-category amounts instead of dumping everything
      // into the transaction-level category.
      const result = await query(
        `SELECT l.category_id,
                c.name      AS category_name,
                c.parent_id AS parent_id,
                p.name      AS parent_name,
                SUM(-l.amount_cents)::bigint AS total_cents,
                COUNT(DISTINCT l.transaction_id)::int AS transaction_count
           FROM transaction_category_lines l
      LEFT JOIN categories c ON c.id = l.category_id
      LEFT JOIN categories p ON p.id = c.parent_id
          WHERE l.amount_cents < 0
            AND l.transfer_group_id IS NULL
            AND l.txn_date >= $1::date
            AND l.txn_date <= $2::date
            AND ($3::uuid IS NULL OR l.account_id = $3)
       GROUP BY l.category_id, c.name, c.parent_id, p.name
       ORDER BY total_cents DESC`,
        [startParam, endParam, accountIdParam],
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
      const months = Math.min(
        Math.max(Number(req.query.months) || 12, 1),
        60,
      );
      const accountIdParam = req.query.accountId?.trim() || null;
      if (accountIdParam && !isUuid(accountIdParam)) {
        return reply.code(400).send({ error: 'Invalid accountId' });
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
            AND ($2::uuid IS NULL OR t.account_id = $2)
       GROUP BY s.month_start
       ORDER BY s.month_start`,
        [months, accountIdParam],
      );
      return { months, rows: result.rows };
    },
  );

  // Net worth at the end of each month for the last N months.
  app.get<{ Querystring: InsightsQuery }>(
    '/api/insights/net-worth-over-time',
    async (req, reply) => {
      const months = Math.min(
        Math.max(Number(req.query.months) || 12, 1),
        60,
      );

      // For each month-end, sum across accounts of (opening_balance plus
      // post-opening txns up to that month-end). Transfers self-cancel so
      // they're harmless here.
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
         )
         SELECT to_char(me.month_start, 'YYYY-MM') AS month,
                COALESCE(SUM(
                  a.opening_balance_cents +
                  COALESCE((
                    SELECT SUM(t.amount_cents)
                      FROM transactions t
                     WHERE t.account_id = a.id
                       AND (a.opening_balance_date IS NULL
                            OR t.txn_date >= a.opening_balance_date)
                       AND t.txn_date <= me.month_end
                  ), 0)
                ), 0)::bigint AS net_worth_cents
           FROM month_ends me
     CROSS JOIN accounts a
       GROUP BY me.month_start
       ORDER BY me.month_start`,
        [months],
      );
      return { months, rows: result.rows };
    },
  );
}
