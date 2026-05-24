import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { assertCategoryUsableByTenant, requireTenant } from '../auth/rbac.js';
import {
  type BillRow,
  type IncomeRow,
  instancesIn,
} from '../domain/budget-wizard.js';

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
  b.category_id, b.bill_id, b.amount_cents, b.created_at,
  c.name AS category_name, c.parent_id,
  bl.name AS bill_name, bl.next_due_date AS bill_next_due_date`;

/**
 * 0.14.1 — every budget route is tenant-scoped. List/actual filter by
 * `b.tenant_id`; mutations write `tenant_id` from the session and
 * filter the WHERE clause by it so cross-tenant probes 404 identically
 * to unknown ids. The `actual` aggregation also joins
 * `transaction_category_lines → accounts` to keep per-category totals
 * from leaking across tenants.
 */
export async function budgetRoutes(app: FastifyInstance): Promise<void> {
  // List budgets. Filter by anchor month for backward compatibility, OR
  // list everything when `all=1`.
  app.get<{ Querystring: { month?: string; all?: string } }>(
    '/api/budgets',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (req.query.all === '1') {
        const rows = await query(
          `SELECT ${BUDGET_COLUMNS}
             FROM budgets b
        LEFT JOIN categories c ON c.id = b.category_id
        LEFT JOIN bills      bl ON bl.id = b.bill_id
            WHERE b.tenant_id = $1
         ORDER BY b.period_type, b.period_month, c.name NULLS LAST`,
          [tenantId],
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
      LEFT JOIN bills      bl ON bl.id = b.bill_id
          WHERE b.tenant_id = $1
            AND b.period_month = $2::date
       ORDER BY (b.category_id IS NULL),  -- flex pool last
                c.name NULLS LAST`,
        [tenantId, month],
      );
      return { month, budgets: rows.rows };
    },
  );

  // Create a budget. `periodStart` (preferred) or legacy `periodMonth`
  // anchors the window. `periodType` defaults to 'monthly'; for 'custom'
  // a `periodEnd` is required and must be after the start.
  app.post('/api/budgets', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
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
      const ok = await assertCategoryUsableByTenant(tenantId, body.categoryId);
      if (!ok) return reply.code(400).send({ error: 'Invalid categoryId' });
      categoryId = body.categoryId;
    }

    // Monthly + first-of-month upsert. Scoped to caller's tenant so
    // two tenants can each have their own monthly budget for the same
    // category in the same month.
    if (periodType === 'monthly' && isFirstOfMonth(anchor)) {
      const existing = await query<{ id: string }>(
        `SELECT id FROM budgets
          WHERE tenant_id = $1
            AND period_type = 'monthly'
            AND period_month = $2::date
            AND COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid)
                = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          LIMIT 1`,
        [tenantId, anchor, categoryId],
      );
      if (existing.rowCount! > 0) {
        const upd = await query(
          `UPDATE budgets SET amount_cents = $1
            WHERE id = $2 AND tenant_id = $3
        RETURNING id, period_month, period_type, period_end, category_id,
                  amount_cents, created_at`,
          [amountCents, existing.rows[0]!.id, tenantId],
        );
        return reply.code(200).send({ budget: upd.rows[0] });
      }
    }

    const ins = await query(
      `INSERT INTO budgets
         (tenant_id, period_month, period_type, period_end, category_id, amount_cents)
       VALUES ($1, $2::date, $3, $4::date, $5, $6)
       RETURNING id, period_month, period_type, period_end, category_id,
                 amount_cents, created_at`,
      [tenantId, anchor, periodType, periodEnd, categoryId, amountCents],
    );
    return reply.code(201).send({ budget: ins.rows[0] });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/budgets/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
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
        `UPDATE budgets SET amount_cents = $1
          WHERE id = $2 AND tenant_id = $3
      RETURNING id, period_month, period_type, period_end, category_id,
                amount_cents, created_at`,
        [amountCents, req.params.id, tenantId],
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
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid budget id' });
      }
      const r = await query(
        'DELETE FROM budgets WHERE id = $1 AND tenant_id = $2',
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Budget not found' });
      }
      return reply.code(204).send();
    },
  );

  // Copy monthly budgets from one month to another. Tenant-scoped on
  // both source and destination — copying across tenants is impossible.
  app.post<{ Body: { fromMonth?: unknown; toMonth?: unknown } }>(
    '/api/budgets/copy',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
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
        `INSERT INTO budgets (tenant_id, period_month, period_type, category_id, amount_cents)
         SELECT $1, $3::date, 'monthly', src.category_id, src.amount_cents
           FROM budgets src
          WHERE src.tenant_id = $1
            AND src.period_month = $2::date
            AND src.period_type = 'monthly'
            AND NOT EXISTS (
              SELECT 1 FROM budgets dst
               WHERE dst.tenant_id = $1
                 AND dst.period_type = 'monthly'
                 AND dst.period_month = $3::date
                 AND COALESCE(dst.category_id, '00000000-0000-0000-0000-000000000000'::uuid)
                     = COALESCE(src.category_id, '00000000-0000-0000-0000-000000000000'::uuid)
            )
         RETURNING id`,
        [tenantId, fromMonth, toMonth],
      );
      return { copied: r.rowCount ?? 0 };
    },
  );

  // Budget vs actual. Filters budgets by tenant; the per-period
  // category-totals join `transaction_category_lines → accounts` so
  // tenant-A budgets never see tenant-B spending bleeding in.
  app.get<{ Querystring: { month?: string; asOf?: string } }>(
    '/api/budgets/actual',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
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
        bill_id: string | null;
        amount_cents: number;
        category_name: string | null;
        bill_name: string | null;
        bill_next_due_date: string | null;
        included_account_ids: string[] | null;
      }>(
        useAsOf
          ? `SELECT ${BUDGET_COLUMNS}, b.included_account_ids
               FROM budgets b
          LEFT JOIN categories c ON c.id = b.category_id
          LEFT JOIN bills      bl ON bl.id = b.bill_id
              WHERE b.tenant_id = $1`
          : `SELECT ${BUDGET_COLUMNS}, b.included_account_ids
               FROM budgets b
          LEFT JOIN categories c ON c.id = b.category_id
          LEFT JOIN bills      bl ON bl.id = b.bill_id
              WHERE b.tenant_id = $1
                AND b.period_type = 'monthly'
                AND b.period_month = $2::date`,
        useAsOf ? [tenantId] : [tenantId, month],
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
        bill_id: string | null;
        bill_name: string | null;
        bill_next_due_date: string | null;
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
        if (b.bill_id !== null) {
          actualCents =
            b.bill_next_due_date !== null && b.bill_next_due_date >= period.end
              ? Number(b.amount_cents)
              : 0;
        } else if (b.category_id !== null) {
          // Tenant filter via accounts join — spending from another
          // tenant's transactions cannot contribute to this tenant's
          // per-category totals even if the category_id is shared.
          //
          // 0.17.11 — if the budget row has an account scope
          // (`included_account_ids`), only transactions from those
          // accounts count. NULL scope keeps the legacy "all
          // accounts in tenant" behavior.
          const r = await query<{ total: number }>(
            `SELECT COALESCE(SUM(-l.amount_cents), 0)::bigint AS total
               FROM transaction_category_lines l
               JOIN accounts a ON a.id = l.account_id
              WHERE a.tenant_id = $1
                AND l.category_id = $2
                AND l.amount_cents < 0
                AND l.transfer_group_id IS NULL
                AND l.txn_date >= $3::date
                AND l.txn_date < $4::date
                AND ($5::uuid[] IS NULL OR a.id = ANY($5::uuid[]))`,
            [tenantId, b.category_id, period.start, period.end, b.included_account_ids],
          );
          actualCents = Number(r.rows[0]!.total);
        } else {
          // Flex pool: every spending line that isn't explicitly budgeted.
          // 0.17.11 — same account-scope filter when the row has one.
          const r = await query<{ total: number }>(
            `SELECT COALESCE(SUM(-l.amount_cents), 0)::bigint AS total
               FROM transaction_category_lines l
               JOIN accounts a ON a.id = l.account_id
              WHERE a.tenant_id = $1
                AND l.amount_cents < 0
                AND l.transfer_group_id IS NULL
                AND l.txn_date >= $2::date
                AND l.txn_date < $3::date
                AND (l.category_id IS NULL OR l.category_id <> ALL($4::uuid[]))
                AND ($5::uuid[] IS NULL OR a.id = ANY($5::uuid[]))`,
            [tenantId, period.start, period.end, explicitCategoryIds, b.included_account_ids],
          );
          actualCents = Number(r.rows[0]!.total);
        }
        rows.push({
          id: b.id,
          category_id: b.category_id,
          bill_id: b.bill_id,
          bill_name: b.bill_name,
          bill_next_due_date: b.bill_next_due_date,
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

  // ── 0.17.7: period cash-flow view ──────────────────────────
  //
  // Returns the period covering `asOf` plus its income events
  // (per-instance with dates), bill events (per-instance with
  // vendor + due date), modifiable category budgets, and totals
  // with net. Used by the new "Period overview" section on
  // /budgets — the cash-flow layout the budget-vs-actual table
  // doesn't provide.
  //
  // The endpoint picks the FIRST budget row whose period covers
  // asOf to determine the active period window — that way users
  // running the wizard on weekly cadence get a weekly view,
  // monthly cadence gets a monthly view, etc. If no budget rows
  // exist for asOf, it falls back to the calendar month
  // containing asOf so the UI still has something to render.
  app.get<{ Querystring: { asOf?: string } }>(
    '/api/budgets/period',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const asOf = isYmd(req.query.asOf) ? req.query.asOf : ymdToday();
      const ctx = await fetchPeriodCtx(tenantId);

      // Pick the active period by scanning budget rows. The first
      // row whose currentPeriod covers asOf defines the window.
      let activeWindow: { start: string; end: string; type: PeriodType } | null = null;
      const activeRows: typeof ctx.budgets = [];
      for (const b of ctx.budgets) {
        const win = currentPeriod({
          anchor: b.period_month,
          periodType: b.period_type,
          periodEnd: b.period_end,
          asOf,
        });
        if (asOf >= win.start && asOf < win.end) {
          if (activeWindow === null) {
            activeWindow = { start: win.start, end: win.end, type: b.period_type };
          }
          activeRows.push(b);
        }
      }
      if (!activeWindow) {
        // No budget rows cover asOf. Fall back to a calendar-month
        // window so the UI still renders something useful: income
        // + bill instances from the master tables, no editable
        // budgets (since none exist for this window).
        const [y, m] = asOf.split('-').map(Number) as [number, number];
        const start = `${y}-${String(m).padStart(2, '0')}-01`;
        const end = nextMonthStart(start);
        activeWindow = { start, end, type: 'monthly' };
      }

      const summary = buildPeriodSummary(activeWindow, activeRows, ctx);
      return { ...summary, asOf };
    },
  );

  // ── 0.17.10: ALL committed periods, stacked ────────────────
  //
  // The user runs AutoMagic with, say, 5 weekly periods. They
  // want to see all 5 cards on /budgets — one per period —
  // before the monthly budget-vs-actual section. The plural
  // endpoint groups budget rows by their distinct period
  // window, builds a per-period summary for each, and returns
  // them sorted ascending by period start. Falls back to a
  // single calendar-month placeholder when no commits exist
  // (so the UI's empty state CTA renders inside a card).
  app.get('/api/budgets/periods', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const ctx = await fetchPeriodCtx(tenantId);

    // Group budget rows by distinct window. Window is computed
    // from each row's (anchor, type, period_end) — the wizard
    // creates rows at distinct anchors per period, so the
    // groupings collapse naturally.
    const groups = new Map<
      string,
      {
        window: { start: string; end: string; type: PeriodType };
        rows: typeof ctx.budgets;
      }
    >();
    for (const b of ctx.budgets) {
      const win = currentPeriod({
        anchor: b.period_month,
        periodType: b.period_type,
        periodEnd: b.period_end,
        // asOf = the anchor itself returns the canonical window
        // for THIS row, not whatever cadence-step covers today.
        asOf: b.period_month,
      });
      const key = `${win.start}|${win.end}|${b.period_type}`;
      const existing = groups.get(key);
      if (existing) {
        existing.rows.push(b);
      } else {
        groups.set(key, {
          window: { start: win.start, end: win.end, type: b.period_type },
          rows: [b],
        });
      }
    }

    if (groups.size === 0) {
      // No commits: return one calendar-month placeholder so the
      // UI still has a card to render with bills + income + the
      // "Run AutoMagic" CTA. asOf defaults to today.
      const today = ymdToday();
      const [y, m] = today.split('-').map(Number) as [number, number];
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      const end = nextMonthStart(start);
      const window = { start, end, type: 'monthly' as PeriodType };
      return {
        periods: [{ ...buildPeriodSummary(window, [], ctx), asOf: today }],
      };
    }

    const periods = Array.from(groups.values())
      .map(({ window, rows }) => ({
        ...buildPeriodSummary(window, rows, ctx),
        asOf: window.start,
      }))
      .sort((a, b) => a.period.start.localeCompare(b.period.start));
    return { periods };
  });

}

// ── 0.17.10: shared helpers for the period summary endpoints ─

interface BudgetRowSummary {
  id: string;
  period_month: string;
  period_type: PeriodType;
  period_end: string | null;
  category_id: string | null;
  bill_id: string | null;
  amount_cents: number;
  category_name: string | null;
  bill_name: string | null;
  /** 0.17.11 — see migration 035. NULL = include every account. */
  included_account_ids: string[] | null;
}

interface PeriodCtx {
  budgets: BudgetRowSummary[];
  bills: BillRow[];
  income: IncomeRow[];
}

/**
 * Pulls the three input sets the period summary needs in parallel.
 * Tenant-scoped. Used by both /api/budgets/period (singular) and
 * /api/budgets/periods (plural) so the SELECTs aren't duplicated.
 */
async function fetchPeriodCtx(tenantId: string): Promise<PeriodCtx> {
  const [budgets, bills, income] = await Promise.all([
    query<BudgetRowSummary>(
      `SELECT b.id, b.period_month, b.period_type, b.period_end,
              b.category_id, b.bill_id, b.amount_cents,
              b.included_account_ids,
              c.name AS category_name,
              bl.name AS bill_name
         FROM budgets b
    LEFT JOIN categories c ON c.id = b.category_id
    LEFT JOIN bills      bl ON bl.id = b.bill_id
        WHERE b.tenant_id = $1`,
      [tenantId],
    ),
    pool.query<BillRow>(
      `SELECT id, name, amount_cents, frequency, next_due_date
         FROM bills WHERE tenant_id = $1 AND active`,
      [tenantId],
    ),
    pool.query<IncomeRow>(
      `SELECT id, name, amount_cents, frequency, next_expected_date
         FROM recurring_income WHERE tenant_id = $1 AND active`,
      [tenantId],
    ),
  ]);
  return { budgets: budgets.rows, bills: bills.rows, income: income.rows };
}

/**
 * Builds a single period summary: income events + bill events +
 * editable category budgets + totals + has_committed_budgets, for
 * the given window. `activeRows` is the subset of budget rows
 * whose periods overlap this window (already filtered by caller).
 * `ctx.bills` and `ctx.income` are the unfiltered master tables;
 * we filter them by window here via instancesIn.
 */
function buildPeriodSummary(
  window: { start: string; end: string; type: PeriodType },
  activeRows: BudgetRowSummary[],
  ctx: PeriodCtx,
) {
  const incomeEvents = instancesIn(
    ctx.income,
    window.start,
    window.end,
    'next_expected_date',
  );

  const billInstances = instancesIn(
    ctx.bills,
    window.start,
    window.end,
    'next_due_date',
  );
  const committedByBillId = new Map(
    activeRows.filter((r) => r.bill_id !== null).map((r) => [r.bill_id!, r]),
  );
  const billEvents = billInstances
    .map((inst) => {
      const committed = committedByBillId.get(inst.id);
      return {
        budget_id: committed?.id ?? null,
        bill_id: inst.id,
        name: inst.name,
        amount_cents: committed ? Number(committed.amount_cents) : inst.amount_cents,
        date: inst.date,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Modifiable / editable category budgets. "Savings" is the one
  // that requires manual action (the user has to transfer money
  // each period). Others are pre-committed spending caps.
  const editable = activeRows
    .filter((r) => r.category_id !== null)
    .map((r) => ({
      budget_id: r.id,
      category_id: r.category_id!,
      category_name: r.category_name ?? '(uncategorized)',
      amount_cents: Number(r.amount_cents),
      requires_manual_action:
        (r.category_name ?? '').toLowerCase() === 'savings',
    }))
    .sort((a, b) => a.category_name.localeCompare(b.category_name));

  const totals = {
    income_cents: incomeEvents.reduce((s, e) => s + Number(e.amount_cents), 0),
    bills_cents: billEvents.reduce((s, e) => s + Number(e.amount_cents), 0),
    editable_cents: editable.reduce((s, e) => s + Number(e.amount_cents), 0),
    net_cents: 0,
  };
  totals.net_cents = totals.income_cents - totals.bills_cents - totals.editable_cents;

  // 0.17.11 — period-level account scope. All rows in a wizard
  // run share the same scope by construction; we surface the
  // first row's scope as the period's. NULL = no scope (every
  // account counts).
  const periodScope =
    activeRows.find((r) => r.included_account_ids !== null)?.included_account_ids ??
    null;

  return {
    period: window,
    income: incomeEvents,
    bills: billEvents,
    editable,
    totals,
    has_committed_budgets: activeRows.length > 0,
    included_account_ids: periodScope,
  };
}

function nextMonthStart(ymd: string): string {
  const [y, m] = ymd.split('-').map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

function ymdToday(): string {
  return new Date().toISOString().slice(0, 10);
}
