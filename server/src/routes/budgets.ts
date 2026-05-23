import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';

interface BudgetBody {
  periodMonth?: unknown;
  categoryId?: unknown;
  amountCents?: unknown;
}

function isFirstOfMonth(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-01$/.test(s);
}

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Budgets — one row per (period_month, category). category_id IS NULL
 * is the flex pool: it catches spending in categories that don't have an
 * explicit row that month.
 */
export async function budgetRoutes(app: FastifyInstance): Promise<void> {
  // List budgets for a month.
  app.get<{ Querystring: { month?: string } }>(
    '/api/budgets',
    async (req, reply) => {
      const month = req.query.month?.trim();
      if (!isFirstOfMonth(month)) {
        return reply
          .code(400)
          .send({ error: 'month must be a YYYY-MM-01 date' });
      }
      const rows = await query(
        `SELECT b.id, b.period_month, b.category_id, b.amount_cents,
                b.created_at, c.name AS category_name, c.parent_id
           FROM budgets b
      LEFT JOIN categories c ON c.id = b.category_id
          WHERE b.period_month = $1::date
       ORDER BY (b.category_id IS NULL),  -- flex pool last
                c.name NULLS LAST`,
        [month],
      );
      return { month, budgets: rows.rows };
    },
  );

  // Create or update (upsert by month + category).
  app.post('/api/budgets', async (req, reply) => {
    const body = (req.body ?? {}) as BudgetBody;
    if (!isFirstOfMonth(body.periodMonth)) {
      return reply
        .code(400)
        .send({ error: 'periodMonth must be a YYYY-MM-01 date' });
    }
    const amountCents = asPositiveInt(body.amountCents);
    if (amountCents === null) {
      return reply
        .code(400)
        .send({ error: 'amountCents must be a positive integer' });
    }
    let categoryId: string | null = null;
    if (body.categoryId !== undefined && body.categoryId !== null) {
      if (typeof body.categoryId !== 'string' || !isUuid(body.categoryId)) {
        return reply.code(400).send({ error: 'Invalid categoryId' });
      }
      categoryId = body.categoryId;
    }
    // Upsert against the (period_month, COALESCE(category_id, sentinel)) unique index.
    const result = await query(
      `INSERT INTO budgets (period_month, category_id, amount_cents)
       VALUES ($1, $2, $3)
       ON CONFLICT (period_month,
                    COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET amount_cents = EXCLUDED.amount_cents
       RETURNING id, period_month, category_id, amount_cents, created_at`,
      [body.periodMonth, categoryId, amountCents],
    );
    return reply.code(201).send({ budget: result.rows[0] });
  });

  app.delete<{ Params: { id: string } }>(
    '/api/budgets/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid budget id' });
      }
      const r = await query('DELETE FROM budgets WHERE id = $1', [req.params.id]);
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Budget not found' });
      }
      return reply.code(204).send();
    },
  );

  // Copy every budget row from one month to another, skipping rows that
  // already exist in the destination. Returns the count actually copied.
  app.post<{ Body: { fromMonth?: unknown; toMonth?: unknown } }>(
    '/api/budgets/copy',
    async (req, reply) => {
      const { fromMonth, toMonth } = (req.body ?? {}) as {
        fromMonth?: unknown;
        toMonth?: unknown;
      };
      if (!isFirstOfMonth(fromMonth) || !isFirstOfMonth(toMonth)) {
        return reply.code(400).send({
          error: 'fromMonth and toMonth must both be YYYY-MM-01 dates',
        });
      }
      const r = await query(
        `INSERT INTO budgets (period_month, category_id, amount_cents)
         SELECT $2::date, src.category_id, src.amount_cents
           FROM budgets src
          WHERE src.period_month = $1::date
         ON CONFLICT (period_month,
                      COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO NOTHING
         RETURNING id`,
        [fromMonth, toMonth],
      );
      return { copied: r.rowCount ?? 0 };
    },
  );

  // Budget vs actual for a month. Each explicit category budget shows
  // its actual spending; the flex-pool row (if present) shows spending
  // in categories that are NOT explicitly budgeted that month.
  app.get<{ Querystring: { month?: string } }>(
    '/api/budgets/actual',
    async (req, reply) => {
      const month = req.query.month?.trim();
      if (!isFirstOfMonth(month)) {
        return reply
          .code(400)
          .send({ error: 'month must be a YYYY-MM-01 date' });
      }
      const budgets = await query<{
        id: string;
        period_month: string;
        category_id: string | null;
        amount_cents: number;
        category_name: string | null;
        parent_id: string | null;
      }>(
        `SELECT b.id, b.period_month, b.category_id, b.amount_cents,
                c.name AS category_name, c.parent_id
           FROM budgets b
      LEFT JOIN categories c ON c.id = b.category_id
          WHERE b.period_month = $1::date`,
        [month],
      );

      const explicitCategoryIds = budgets.rows
        .map((r) => r.category_id)
        .filter((id): id is string => id !== null);

      const rows: Array<{
        id: string;
        category_id: string | null;
        category_name: string | null;
        budgeted_cents: number;
        actual_cents: number;
      }> = [];

      for (const b of budgets.rows) {
        let actualCents: number;
        if (b.category_id !== null) {
          const r = await query<{ total: number }>(
            `SELECT COALESCE(SUM(-amount_cents), 0)::bigint AS total
               FROM transactions
              WHERE category_id = $1
                AND amount_cents < 0
                AND transfer_group_id IS NULL
                AND txn_date >= $2::date
                AND txn_date < ($2::date + interval '1 month')::date`,
            [b.category_id, month],
          );
          actualCents = Number(r.rows[0]!.total);
        } else {
          // Flex pool: everything in categories that aren't explicitly
          // budgeted this month (and uncategorized rows too).
          const r = await query<{ total: number }>(
            `SELECT COALESCE(SUM(-amount_cents), 0)::bigint AS total
               FROM transactions
              WHERE amount_cents < 0
                AND transfer_group_id IS NULL
                AND txn_date >= $1::date
                AND txn_date < ($1::date + interval '1 month')::date
                AND (category_id IS NULL OR category_id <> ALL($2::uuid[]))`,
            [month, explicitCategoryIds],
          );
          actualCents = Number(r.rows[0]!.total);
        }
        rows.push({
          id: b.id,
          category_id: b.category_id,
          category_name:
            b.category_name ?? (b.category_id === null ? null : 'Unknown'),
          budgeted_cents: Number(b.amount_cents),
          actual_cents: actualCents,
        });
      }

      const totals = rows.reduce(
        (acc, r) => ({
          budgeted_cents: acc.budgeted_cents + r.budgeted_cents,
          actual_cents: acc.actual_cents + r.actual_cents,
        }),
        { budgeted_cents: 0, actual_cents: 0 },
      );

      return { month, rows, totals };
    },
  );
}
