import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';

type PeriodType = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'custom';
const PERIOD_TYPES: PeriodType[] = [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'custom',
];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

interface BudgetBody {
  periodMonth?: unknown; // legacy alias kept for backward compat
  periodStart?: unknown;
  periodType?: unknown;
  periodEnd?: unknown;
  categoryId?: unknown;
  amountCents?: unknown;
}

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function isYmd(value: unknown): value is string {
  return typeof value === 'string' && YMD.test(value);
}

function isFirstOfMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-01$/.test(value);
}

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
  return Math.floor(
    (Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / (1000 * 60 * 60 * 24),
  );
}

/**
 * Given a budget's anchor date + period type + (optional) explicit end,
 * compute the [start, end) range covering `asOf`. For non-custom cadences
 * the window steps forward by the cadence length from the anchor. Custom
 * is a one-shot range — if `asOf` falls outside it, return the original
 * window (the UI then knows it's expired).
 */
export function currentPeriod(opts: {
  anchor: string;
  periodType: PeriodType;
  periodEnd: string | null;
  asOf: string;
}): { start: string; end: string } {
  const { anchor, periodType, periodEnd, asOf } = opts;

  if (periodType === 'custom') {
    return { start: anchor, end: periodEnd ?? addDays(anchor, 30) };
  }

  if (periodType === 'monthly') {
    // Anchor day-of-month wins; month rolls based on asOf.
    const [, , dRaw] = anchor.split('-') as [string, string, string];
    const day = Math.min(28, Number(dRaw));
    const [yAs, mAs] = asOf.split('-').map(Number) as [number, number];
    const start = `${yAs}-${String(mAs).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const startNorm = asOf < start ? addMonths(start, -1) : start;
    return { start: startNorm, end: addMonths(startNorm, 1) };
  }

  if (periodType === 'semimonthly') {
    // Two windows per month: anchor.day → +15d, and (anchor.day+15) → end-of-month.
    // For simplicity always model as 15-day blocks rolling from anchor.
    const elapsed = daysBetween(anchor, asOf);
    if (elapsed < 0) return { start: anchor, end: addDays(anchor, 15) };
    const blocks = Math.floor(elapsed / 15);
    const start = addDays(anchor, blocks * 15);
    return { start, end: addDays(start, 15) };
  }

  const stride = periodType === 'weekly' ? 7 : 14; // biweekly
  const elapsed = daysBetween(anchor, asOf);
  if (elapsed < 0) return { start: anchor, end: addDays(anchor, stride) };
  const blocks = Math.floor(elapsed / stride);
  const start = addDays(anchor, blocks * stride);
  return { start, end: addDays(start, stride) };
}

const BUDGET_COLUMNS = `b.id, b.period_month, b.period_type, b.period_end,
  b.category_id, b.amount_cents, b.created_at,
  c.name AS category_name, c.parent_id`;

export async function budgetRoutes(app: FastifyInstance): Promise<void> {
  // List budgets. Filter by anchor month for backward compatibility, OR
  // list everything when `all=1`.
  app.get<{ Querystring: { month?: string; all?: string } }>(
    '/api/budgets',
    async (req, reply) => {
      if (req.query.all === '1') {
        const rows = await query(
          `SELECT ${BUDGET_COLUMNS}
             FROM budgets b
        LEFT JOIN categories c ON c.id = b.category_id
         ORDER BY b.period_type, b.period_month, c.name NULLS LAST`,
        );
        return { budgets: rows.rows };
      }
      const month = req.query.month?.trim();
      if (!isFirstOfMonth(month)) {
        return reply
          .code(400)
          .send({ error: 'month must be a YYYY-MM-01 date (or use ?all=1)' });
      }
      const rows = await query(
        `SELECT ${BUDGET_COLUMNS}
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

  // Create a budget. `periodStart` (preferred) or legacy `periodMonth`
  // anchors the window. `periodType` defaults to 'monthly'; for 'custom'
  // a `periodEnd` is required and must be after the start.
  app.post('/api/budgets', async (req, reply) => {
    const body = (req.body ?? {}) as BudgetBody;

    const anchor =
      (isYmd(body.periodStart) && body.periodStart) ||
      (isYmd(body.periodMonth) && body.periodMonth) ||
      null;
    if (!anchor) {
      return reply
        .code(400)
        .send({ error: 'periodStart must be a YYYY-MM-DD date' });
    }

    const periodType =
      body.periodType === undefined ? 'monthly' : (body.periodType as PeriodType);
    if (!PERIOD_TYPES.includes(periodType)) {
      return reply.code(400).send({
        error: `periodType must be one of: ${PERIOD_TYPES.join(', ')}`,
      });
    }
    // Monthly anchors used to require day=1; we now accept any day-of-month
    // but warn callers via the 'custom' path if they want a non-rolling
    // window. To stay backward-compatible with old callers passing
    // `periodMonth` as YYYY-MM-01, leave that path unchanged.

    let periodEnd: string | null = null;
    if (periodType === 'custom') {
      if (!isYmd(body.periodEnd) || body.periodEnd <= anchor) {
        return reply
          .code(400)
          .send({ error: 'periodEnd is required for custom and must be after periodStart' });
      }
      periodEnd = body.periodEnd as string;
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

    // For monthly budgets that target the same (start, category), keep
    // the upsert UX so editing from the UI updates the existing row.
    // Other period types always insert a new row.
    if (periodType === 'monthly' && isFirstOfMonth(anchor)) {
      const existing = await query<{ id: string }>(
        `SELECT id FROM budgets
          WHERE period_type = 'monthly'
            AND period_month = $1::date
            AND COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid)
                = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          LIMIT 1`,
        [anchor, categoryId],
      );
      if (existing.rowCount! > 0) {
        const upd = await query(
          `UPDATE budgets SET amount_cents = $1 WHERE id = $2
        RETURNING id, period_month, period_type, period_end, category_id,
                  amount_cents, created_at`,
          [amountCents, existing.rows[0]!.id],
        );
        return reply.code(200).send({ budget: upd.rows[0] });
      }
    }

    const ins = await query(
      `INSERT INTO budgets
         (period_month, period_type, period_end, category_id, amount_cents)
       VALUES ($1::date, $2, $3::date, $4, $5)
       RETURNING id, period_month, period_type, period_end, category_id,
                 amount_cents, created_at`,
      [anchor, periodType, periodEnd, categoryId, amountCents],
    );
    return reply.code(201).send({ budget: ins.rows[0] });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/budgets/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid budget id' });
      }
      const body = (req.body ?? {}) as { amountCents?: unknown };
      const amountCents = asPositiveInt(body.amountCents);
      if (amountCents === null) {
        return reply
          .code(400)
          .send({ error: 'amountCents must be a positive integer' });
      }
      const r = await query(
        `UPDATE budgets SET amount_cents = $1 WHERE id = $2
      RETURNING id, period_month, period_type, period_end, category_id,
                amount_cents, created_at`,
        [amountCents, req.params.id],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Budget not found' });
      }
      return { budget: r.rows[0] };
    },
  );

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

  // Copy monthly budgets from one month to another. Skips rows that
  // already exist for the destination month.
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
        `INSERT INTO budgets (period_month, period_type, category_id, amount_cents)
         SELECT $2::date, 'monthly', src.category_id, src.amount_cents
           FROM budgets src
          WHERE src.period_month = $1::date
            AND src.period_type = 'monthly'
            AND NOT EXISTS (
              SELECT 1 FROM budgets dst
               WHERE dst.period_type = 'monthly'
                 AND dst.period_month = $2::date
                 AND COALESCE(dst.category_id, '00000000-0000-0000-0000-000000000000'::uuid)
                     = COALESCE(src.category_id, '00000000-0000-0000-0000-000000000000'::uuid)
            )
         RETURNING id`,
        [fromMonth, toMonth],
      );
      return { copied: r.rowCount ?? 0 };
    },
  );

  // Budget vs actual. The legacy `month` query param scopes to monthly
  // budgets whose period_month equals that date. The new `asOf` param
  // returns every budget with the active [start, end) covering that date.
  app.get<{ Querystring: { month?: string; asOf?: string } }>(
    '/api/budgets/actual',
    async (req, reply) => {
      const useAsOf = isYmd(req.query.asOf);
      const month = req.query.month?.trim();
      if (!useAsOf && !isFirstOfMonth(month)) {
        return reply
          .code(400)
          .send({ error: 'Provide month=YYYY-MM-01 or asOf=YYYY-MM-DD' });
      }

      const budgets = await query<{
        id: string;
        period_month: string;
        period_type: PeriodType;
        period_end: string | null;
        category_id: string | null;
        amount_cents: number;
        category_name: string | null;
      }>(
        useAsOf
          ? `SELECT ${BUDGET_COLUMNS}
               FROM budgets b
          LEFT JOIN categories c ON c.id = b.category_id`
          : `SELECT ${BUDGET_COLUMNS}
               FROM budgets b
          LEFT JOIN categories c ON c.id = b.category_id
              WHERE b.period_type = 'monthly' AND b.period_month = $1::date`,
        useAsOf ? [] : [month],
      );

      const asOf = useAsOf ? (req.query.asOf as string) : (month as string);
      const explicitCategoryIds = budgets.rows
        .filter((b) => b.period_type === 'monthly')
        .map((r) => r.category_id)
        .filter((id): id is string => id !== null);

      const rows: Array<{
        id: string;
        category_id: string | null;
        category_name: string | null;
        period_type: PeriodType;
        period_start: string;
        period_end: string;
        budgeted_cents: number;
        actual_cents: number;
      }> = [];

      for (const b of budgets.rows) {
        const period = currentPeriod({
          anchor: b.period_month,
          periodType: b.period_type,
          periodEnd: b.period_end,
          asOf,
        });
        let actualCents: number;
        if (b.category_id !== null) {
          const r = await query<{ total: number }>(
            `SELECT COALESCE(SUM(-amount_cents), 0)::bigint AS total
               FROM transactions
              WHERE category_id = $1
                AND amount_cents < 0
                AND transfer_group_id IS NULL
                AND txn_date >= $2::date
                AND txn_date < $3::date`,
            [b.category_id, period.start, period.end],
          );
          actualCents = Number(r.rows[0]!.total);
        } else {
          const r = await query<{ total: number }>(
            `SELECT COALESCE(SUM(-amount_cents), 0)::bigint AS total
               FROM transactions
              WHERE amount_cents < 0
                AND transfer_group_id IS NULL
                AND txn_date >= $1::date
                AND txn_date < $2::date
                AND (category_id IS NULL OR category_id <> ALL($3::uuid[]))`,
            [period.start, period.end, explicitCategoryIds],
          );
          actualCents = Number(r.rows[0]!.total);
        }
        rows.push({
          id: b.id,
          category_id: b.category_id,
          category_name:
            b.category_name ?? (b.category_id === null ? null : 'Unknown'),
          period_type: b.period_type,
          period_start: period.start,
          period_end: period.end,
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

      return { asOf, rows, totals };
    },
  );
}
