import { pool } from '../db/pool.js';

/**
 * Canned reports.
 *
 * Each report has a metadata block (id, label, description, params) and
 * a `run(params, tenantId)` function that returns a { columns, rows }
 * pair. The route layer renders the JSON; the web side displays the
 * table.
 *
 * 0.14.2 — every report is tenant-scoped end-to-end. The route layer
 * MUST pass the caller's tenantId into `run`; each report joins
 * through accounts (for transaction-derived data) or filters
 * `tenant_id` directly (for bills) so the result reflects ONLY that
 * tenant's data. Pre-0.14.2 every report aggregated across every
 * tenant on the instance — a child on one tenant could see
 * household-wide spending totals for every other household.
 */

export interface ReportParamDef {
  name: string;
  label: string;
  type: 'date' | 'int' | 'string';
  default?: string;
  required?: boolean;
}

export interface ReportColumn {
  key: string;
  label: string;
  type: 'string' | 'date' | 'cents' | 'number' | 'pct';
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  total_rows: number;
  /** Optional summary line: e.g. "Total spent: $1,234.56" */
  summary?: string;
}

export interface ReportDefinition {
  id: string;
  label: string;
  description: string;
  params: ReportParamDef[];
  /**
   * Execute the report. `tenantId` is the active tenant from the
   * request; every SQL inside must scope by it.
   */
  run(params: Record<string, string>, tenantId: string): Promise<ReportResult>;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return isoDate(new Date());
}
function yearAgoIso(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return isoDate(d);
}

function dateOr(params: Record<string, string>, name: string, fallback: string): string {
  const v = params[name];
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
}

function intOr(params: Record<string, string>, name: string, fallback: number): number {
  const n = Number(params[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function fmtUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ── Reports ─────────────────────────────────────────────────────

const spendingByCategory: ReportDefinition = {
  id: 'spending-by-category',
  label: 'Spending by category',
  description:
    'Total outflows grouped by category over a date range. Defaults to the last 12 months.',
  params: [
    { name: 'start', label: 'Start date', type: 'date', default: yearAgoIso() },
    { name: 'end', label: 'End date', type: 'date', default: todayIso() },
  ],
  async run(params, tenantId) {
    const start = dateOr(params, 'start', yearAgoIso());
    const end = dateOr(params, 'end', todayIso());
    const r = await pool.query<{
      category_name: string | null;
      parent_name: string | null;
      total_cents: number;
      txn_count: number;
    }>(
      `SELECT
         COALESCE(c.name, 'Uncategorized') AS category_name,
         COALESCE(p.name, '—')             AS parent_name,
         SUM(l.amount_cents)::bigint        AS total_cents,
         COUNT(*)::bigint                   AS txn_count
       FROM transaction_category_lines l
       JOIN accounts a ON a.id = l.account_id
  LEFT JOIN categories c ON c.id = l.category_id
  LEFT JOIN categories p ON p.id = c.parent_id
      WHERE a.tenant_id = $1
        AND l.amount_cents < 0
        AND l.transfer_group_id IS NULL
        AND l.txn_date BETWEEN $2 AND $3
   GROUP BY c.name, p.name
   ORDER BY SUM(l.amount_cents) ASC`,
      [tenantId, start, end],
    );
    const total = r.rows.reduce((sum, row) => sum + Number(row.total_cents), 0);
    return {
      columns: [
        { key: 'parent_name', label: 'Group', type: 'string' },
        { key: 'category_name', label: 'Category', type: 'string' },
        { key: 'total_cents', label: 'Total', type: 'cents' },
        { key: 'txn_count', label: 'Transactions', type: 'number' },
      ],
      rows: r.rows.map((row) => ({ ...row, total_cents: Number(row.total_cents) })),
      total_rows: r.rowCount ?? 0,
      summary: `Outflow ${fmtUsd(total)} across ${r.rowCount ?? 0} categor${(r.rowCount ?? 0) === 1 ? 'y' : 'ies'} from ${start} to ${end}.`,
    };
  },
};

const topMerchants: ReportDefinition = {
  id: 'top-merchants',
  label: 'Top merchants by spend',
  description:
    'Merchants ranked by total outflow over the date range. Useful for finding leaks.',
  params: [
    { name: 'start', label: 'Start date', type: 'date', default: yearAgoIso() },
    { name: 'end', label: 'End date', type: 'date', default: todayIso() },
    { name: 'limit', label: 'Show top N', type: 'int', default: '25' },
  ],
  async run(params, tenantId) {
    const start = dateOr(params, 'start', yearAgoIso());
    const end = dateOr(params, 'end', todayIso());
    const limit = Math.min(intOr(params, 'limit', 25), 200);
    const r = await pool.query<{
      merchant: string;
      total_cents: number;
      txn_count: number;
    }>(
      `SELECT
         COALESCE(t.normalized_merchant, t.raw_description) AS merchant,
         SUM(t.amount_cents)::bigint                         AS total_cents,
         COUNT(*)::bigint                                    AS txn_count
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE a.tenant_id = $1
        AND t.amount_cents < 0
        AND t.transfer_group_id IS NULL
        AND t.txn_date BETWEEN $2 AND $3
   GROUP BY merchant
   ORDER BY SUM(t.amount_cents) ASC
      LIMIT $4`,
      [tenantId, start, end, limit],
    );
    return {
      columns: [
        { key: 'merchant', label: 'Merchant', type: 'string' },
        { key: 'total_cents', label: 'Total', type: 'cents' },
        { key: 'txn_count', label: 'Transactions', type: 'number' },
      ],
      rows: r.rows.map((row) => ({ ...row, total_cents: Number(row.total_cents) })),
      total_rows: r.rowCount ?? 0,
    };
  },
};

const monthlyIncomeExpense: ReportDefinition = {
  id: 'monthly-income-expense',
  label: 'Monthly income vs expense',
  description:
    'Cash in, cash out, and net per month. Transfers are excluded.',
  params: [
    { name: 'months', label: 'Months back', type: 'int', default: '12' },
  ],
  async run(params, tenantId) {
    const months = Math.min(intOr(params, 'months', 12), 60);
    const r = await pool.query<{
      month: string;
      income_cents: number;
      expense_cents: number;
      net_cents: number;
    }>(
      `SELECT
         to_char(date_trunc('month', t.txn_date), 'YYYY-MM')                       AS month,
         COALESCE(SUM(t.amount_cents) FILTER (WHERE t.amount_cents > 0), 0)::bigint AS income_cents,
         COALESCE(SUM(t.amount_cents) FILTER (WHERE t.amount_cents < 0), 0)::bigint AS expense_cents,
         COALESCE(SUM(t.amount_cents), 0)::bigint                                   AS net_cents
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE a.tenant_id = $1
        AND t.transfer_group_id IS NULL
        AND t.txn_date >= (date_trunc('month', now()) - make_interval(months => $2::int))
   GROUP BY 1
   ORDER BY 1 DESC`,
      [tenantId, months],
    );
    return {
      columns: [
        { key: 'month', label: 'Month', type: 'string' },
        { key: 'income_cents', label: 'Income', type: 'cents' },
        { key: 'expense_cents', label: 'Expense', type: 'cents' },
        { key: 'net_cents', label: 'Net', type: 'cents' },
      ],
      rows: r.rows.map((row) => ({
        ...row,
        income_cents: Number(row.income_cents),
        expense_cents: Number(row.expense_cents),
        net_cents: Number(row.net_cents),
      })),
      total_rows: r.rowCount ?? 0,
    };
  },
};

const subscriptionCosts: ReportDefinition = {
  id: 'subscription-costs',
  label: 'Active subscriptions roll-up',
  description:
    'Every active recurring bill with its per-cycle and annualized cost. Quick view of what you\'re paying for.',
  params: [],
  async run(_params, tenantId) {
    // `bills` has its own tenant_id column — direct filter, no join needed.
    const r = await pool.query<{
      name: string;
      frequency: string;
      amount_cents: number;
      annual_cents: number;
      review_status: string;
    }>(
      `SELECT
         name,
         frequency,
         amount_cents::bigint AS amount_cents,
         (CASE frequency
            WHEN 'weekly'   THEN amount_cents * 52
            WHEN 'biweekly' THEN amount_cents * 26
            WHEN 'monthly'  THEN amount_cents * 12
            WHEN 'yearly'   THEN amount_cents
            ELSE 0
         END)::bigint AS annual_cents,
         review_status
       FROM bills
      WHERE tenant_id = $1
        AND active
        AND frequency <> 'one-time'
   ORDER BY annual_cents DESC`,
      [tenantId],
    );
    const total = r.rows.reduce((sum, row) => sum + Number(row.annual_cents), 0);
    return {
      columns: [
        { key: 'name', label: 'Name', type: 'string' },
        { key: 'frequency', label: 'Cadence', type: 'string' },
        { key: 'amount_cents', label: 'Per cycle', type: 'cents' },
        { key: 'annual_cents', label: 'Per year', type: 'cents' },
        { key: 'review_status', label: 'Status', type: 'string' },
      ],
      rows: r.rows.map((row) => ({
        ...row,
        amount_cents: -Math.abs(Number(row.amount_cents)),
        annual_cents: -Math.abs(Number(row.annual_cents)),
      })),
      total_rows: r.rowCount ?? 0,
      summary: `Annualized outflow: ${fmtUsd(-Math.abs(total))} across ${r.rowCount ?? 0} subscription${(r.rowCount ?? 0) === 1 ? '' : 's'}.`,
    };
  },
};

const largestTransactions: ReportDefinition = {
  id: 'largest-transactions',
  label: 'Largest transactions',
  description:
    'Biggest single outflows over the date range. Surfaces anomalies and one-time costs.',
  params: [
    { name: 'start', label: 'Start date', type: 'date', default: yearAgoIso() },
    { name: 'end', label: 'End date', type: 'date', default: todayIso() },
    { name: 'limit', label: 'Show top N', type: 'int', default: '50' },
  ],
  async run(params, tenantId) {
    const start = dateOr(params, 'start', yearAgoIso());
    const end = dateOr(params, 'end', todayIso());
    const limit = Math.min(intOr(params, 'limit', 50), 500);
    const r = await pool.query<{
      txn_date: string;
      merchant: string;
      amount_cents: number;
      category_name: string | null;
      account_name: string;
    }>(
      `SELECT
         to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date,
         COALESCE(t.normalized_merchant, t.raw_description) AS merchant,
         t.amount_cents::bigint AS amount_cents,
         c.name AS category_name,
         a.name AS account_name
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id
      WHERE a.tenant_id = $1
        AND t.amount_cents < 0
        AND t.transfer_group_id IS NULL
        AND t.txn_date BETWEEN $2 AND $3
   ORDER BY t.amount_cents ASC
      LIMIT $4`,
      [tenantId, start, end, limit],
    );
    return {
      columns: [
        { key: 'txn_date', label: 'Date', type: 'date' },
        { key: 'merchant', label: 'Merchant', type: 'string' },
        { key: 'category_name', label: 'Category', type: 'string' },
        { key: 'account_name', label: 'Account', type: 'string' },
        { key: 'amount_cents', label: 'Amount', type: 'cents' },
      ],
      rows: r.rows.map((row) => ({ ...row, amount_cents: Number(row.amount_cents) })),
      total_rows: r.rowCount ?? 0,
    };
  },
};

const netWorthByMonth: ReportDefinition = {
  id: 'net-worth-by-month',
  label: 'Net worth by month',
  description:
    'Cumulative net worth at the end of each month across all accounts.',
  params: [
    { name: 'months', label: 'Months back', type: 'int', default: '24' },
  ],
  async run(params, tenantId) {
    const months = Math.min(intOr(params, 'months', 24), 120);
    const r = await pool.query<{
      month: string;
      net_worth_cents: number;
    }>(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', now() - make_interval(months => $1::int)),
           date_trunc('month', now()),
           '1 month'::interval
         )::date AS m
       ),
       openings AS (
         SELECT id, type, opening_balance_cents, opening_balance_date
           FROM accounts
          WHERE tenant_id = $2
       )
       -- 0.19.x — normalize liability sign. A credit_card / loan /
       -- manual_liability account holds a debt, so its contribution
       -- to net worth must always SUBTRACT, regardless of how the
       -- importer chose to sign the transactions. -ABS() makes this
       -- robust to either convention (charges-as-negative from
       -- Plaid-style, or charges-as-positive from some CSV formats).
       SELECT to_char(m.m, 'YYYY-MM') AS month,
              COALESCE(SUM(
                CASE WHEN o.type IN ('credit_card', 'loan', 'manual_liability')
                  THEN -ABS(o.opening_balance_cents +
                    COALESCE((
                      SELECT SUM(t.amount_cents)
                        FROM transactions t
                       WHERE t.account_id = o.id
                         AND (o.opening_balance_date IS NULL OR t.txn_date >= o.opening_balance_date)
                         AND t.txn_date < (m.m + interval '1 month')::date
                    ), 0))
                  ELSE o.opening_balance_cents +
                    COALESCE((
                      SELECT SUM(t.amount_cents)
                        FROM transactions t
                       WHERE t.account_id = o.id
                         AND (o.opening_balance_date IS NULL OR t.txn_date >= o.opening_balance_date)
                         AND t.txn_date < (m.m + interval '1 month')::date
                    ), 0)
                END
              ), 0)::bigint AS net_worth_cents
         FROM months m
         CROSS JOIN openings o
     GROUP BY m.m
     ORDER BY m.m DESC`,
      [months, tenantId],
    );
    return {
      columns: [
        { key: 'month', label: 'Month', type: 'string' },
        { key: 'net_worth_cents', label: 'Net worth', type: 'cents' },
      ],
      rows: r.rows.map((row) => ({
        ...row,
        net_worth_cents: Number(row.net_worth_cents),
      })),
      total_rows: r.rowCount ?? 0,
    };
  },
};

// ── 0.24.4 — additional reports ──────────────────────────────

/**
 * Year-over-year by category. Compares spending in [start, end]
 * against the same window one year earlier. Useful for "am I
 * spending more on dining out than last year?" type questions.
 */
const yearOverYearByCategory: ReportDefinition = {
  id: 'year-over-year-categories',
  label: 'Year-over-year by category',
  description:
    'This period vs the same period one year ago, per category. Surfaces drift and lifestyle creep.',
  params: [
    { name: 'start', label: 'Start (this period)', type: 'date', default: `${new Date().getUTCFullYear()}-01-01` },
    { name: 'end', label: 'End (this period)', type: 'date', default: todayIso() },
  ],
  async run(params, tenantId) {
    const start = dateOr(params, 'start', `${new Date().getUTCFullYear()}-01-01`);
    const end = dateOr(params, 'end', todayIso());
    const r = await pool.query<{
      category_name: string;
      this_period_cents: number;
      last_period_cents: number;
    }>(
      `WITH base AS (
         SELECT COALESCE(c.name, 'Uncategorized') AS category_name,
                l.amount_cents,
                l.txn_date
           FROM transaction_category_lines l
           JOIN accounts a ON a.id = l.account_id
      LEFT JOIN categories c ON c.id = l.category_id
          WHERE a.tenant_id = $1
            AND l.amount_cents < 0
            AND l.transfer_group_id IS NULL
       )
       SELECT category_name,
              -SUM(CASE WHEN txn_date BETWEEN $2 AND $3 THEN amount_cents ELSE 0 END)::bigint
                AS this_period_cents,
              -SUM(CASE WHEN txn_date BETWEEN $2::date - INTERVAL '1 year'
                                       AND $3::date - INTERVAL '1 year'
                        THEN amount_cents ELSE 0 END)::bigint
                AS last_period_cents
         FROM base
     GROUP BY category_name
       HAVING SUM(CASE WHEN txn_date BETWEEN $2 AND $3
                         OR txn_date BETWEEN $2::date - INTERVAL '1 year' AND $3::date - INTERVAL '1 year'
                       THEN 1 ELSE 0 END) > 0
     ORDER BY ABS(
                COALESCE(SUM(CASE WHEN txn_date BETWEEN $2 AND $3 THEN amount_cents ELSE 0 END), 0)
                - COALESCE(SUM(CASE WHEN txn_date BETWEEN $2::date - INTERVAL '1 year' AND $3::date - INTERVAL '1 year' THEN amount_cents ELSE 0 END), 0)
              ) DESC`,
      [tenantId, start, end],
    );
    const rows = r.rows.map((row) => {
      const thisP = Number(row.this_period_cents);
      const lastP = Number(row.last_period_cents);
      const delta = thisP - lastP;
      // pct column type expects a decimal (0.30 = 30%); the
      // frontend formatter multiplies by 100 to render.
      const pctChange = lastP > 0 ? delta / lastP : null;
      return {
        category_name: row.category_name,
        this_period_cents: thisP,
        last_period_cents: lastP,
        delta_cents: delta,
        pct_change: pctChange,
      };
    });
    return {
      columns: [
        { key: 'category_name', label: 'Category', type: 'string' },
        { key: 'this_period_cents', label: 'This period', type: 'cents' },
        { key: 'last_period_cents', label: 'Last year same period', type: 'cents' },
        { key: 'delta_cents', label: 'Δ', type: 'cents' },
        { key: 'pct_change', label: '% change', type: 'pct' },
      ],
      rows,
      total_rows: rows.length,
    };
  },
};

/**
 * Month-over-month spending movers. Compares the most-recent
 * COMPLETED calendar month to the one before it, ranking categories
 * by the size of the swing. Both increases and decreases included.
 */
const monthlyMovers: ReportDefinition = {
  id: 'monthly-movers',
  label: 'Month-over-month movers',
  description:
    'Categories whose spending changed most between the two most recent completed months. Shows you what shifted.',
  params: [],
  async run(_params, tenantId) {
    const r = await pool.query<{
      category_name: string;
      curr_cents: number;
      prev_cents: number;
    }>(
      `WITH last_two AS (
         SELECT date_trunc('month', now())::date - INTERVAL '1 month' AS curr_start,
                date_trunc('month', now())::date AS curr_end,
                date_trunc('month', now())::date - INTERVAL '2 months' AS prev_start,
                date_trunc('month', now())::date - INTERVAL '1 month' AS prev_end
       )
       SELECT COALESCE(c.name, 'Uncategorized') AS category_name,
              -SUM(CASE WHEN l.txn_date >= lt.curr_start AND l.txn_date < lt.curr_end
                        THEN l.amount_cents ELSE 0 END)::bigint AS curr_cents,
              -SUM(CASE WHEN l.txn_date >= lt.prev_start AND l.txn_date < lt.prev_end
                        THEN l.amount_cents ELSE 0 END)::bigint AS prev_cents
         FROM transaction_category_lines l
         CROSS JOIN last_two lt
         JOIN accounts a ON a.id = l.account_id
    LEFT JOIN categories c ON c.id = l.category_id
        WHERE a.tenant_id = $1
          AND l.amount_cents < 0
          AND l.transfer_group_id IS NULL
          AND l.txn_date >= lt.prev_start
          AND l.txn_date < lt.curr_end
     GROUP BY c.name, lt.curr_start, lt.curr_end, lt.prev_start, lt.prev_end
     ORDER BY ABS(
                SUM(CASE WHEN l.txn_date >= lt.curr_start AND l.txn_date < lt.curr_end THEN l.amount_cents ELSE 0 END)
                - SUM(CASE WHEN l.txn_date >= lt.prev_start AND l.txn_date < lt.prev_end THEN l.amount_cents ELSE 0 END)
              ) DESC
        LIMIT 25`,
      [tenantId],
    );
    const rows = r.rows.map((row) => {
      const curr = Number(row.curr_cents);
      const prev = Number(row.prev_cents);
      const delta = curr - prev;
      return {
        category_name: row.category_name,
        prev_cents: prev,
        curr_cents: curr,
        delta_cents: delta,
        direction: delta > 0 ? '↑ up' : delta < 0 ? '↓ down' : '–',
      };
    });
    return {
      columns: [
        { key: 'category_name', label: 'Category', type: 'string' },
        { key: 'prev_cents', label: 'Prior month', type: 'cents' },
        { key: 'curr_cents', label: 'Last month', type: 'cents' },
        { key: 'delta_cents', label: 'Δ', type: 'cents' },
        { key: 'direction', label: 'Direction', type: 'string' },
      ],
      rows,
      total_rows: rows.length,
    };
  },
};

/**
 * Day-of-week spending pattern. Pure behavioral insight — when do
 * you spend? Aggregates outflows by ISO weekday across a date range.
 */
const dayOfWeekPattern: ReportDefinition = {
  id: 'day-of-week-pattern',
  label: 'Day-of-week spending pattern',
  description:
    'Total outflows by weekday across a date range. Surfaces "Friday is your big day" patterns.',
  params: [
    { name: 'start', label: 'Start date', type: 'date', default: yearAgoIso() },
    { name: 'end', label: 'End date', type: 'date', default: todayIso() },
  ],
  async run(params, tenantId) {
    const start = dateOr(params, 'start', yearAgoIso());
    const end = dateOr(params, 'end', todayIso());
    const r = await pool.query<{
      dow: number;
      total_cents: number;
      txn_count: number;
      avg_cents: number;
    }>(
      `SELECT EXTRACT(DOW FROM l.txn_date)::int AS dow,
              -SUM(l.amount_cents)::bigint AS total_cents,
              COUNT(*)::bigint AS txn_count,
              -AVG(l.amount_cents)::bigint AS avg_cents
         FROM transaction_category_lines l
         JOIN accounts a ON a.id = l.account_id
        WHERE a.tenant_id = $1
          AND l.amount_cents < 0
          AND l.transfer_group_id IS NULL
          AND l.txn_date BETWEEN $2 AND $3
     GROUP BY EXTRACT(DOW FROM l.txn_date)
     ORDER BY EXTRACT(DOW FROM l.txn_date)`,
      [tenantId, start, end],
    );
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
      columns: [
        { key: 'day', label: 'Day', type: 'string' },
        { key: 'total_cents', label: 'Total spent', type: 'cents' },
        { key: 'txn_count', label: 'Transactions', type: 'number' },
        { key: 'avg_cents', label: 'Average', type: 'cents' },
      ],
      rows: r.rows.map((row) => ({
        day: dayNames[row.dow] ?? `Day ${row.dow}`,
        total_cents: Number(row.total_cents),
        txn_count: Number(row.txn_count),
        avg_cents: Number(row.avg_cents),
      })),
      total_rows: r.rowCount ?? 0,
    };
  },
};

/**
 * Tax-deductible spending YTD. Uses `categories.tax_category` set
 * by the canonical taxonomy (0.21.0). Output is grouped so a CPA /
 * Schedule C prep sees totals per line item.
 */
const taxDeductibleYtd: ReportDefinition = {
  id: 'tax-deductible-ytd',
  label: 'Tax-deductible spending YTD',
  description:
    'Spending in categories with a tax_category assigned, totaled per Schedule C line item. Useful at tax time.',
  params: [
    { name: 'year', label: 'Tax year', type: 'int', default: String(new Date().getUTCFullYear()) },
  ],
  async run(params, tenantId) {
    const year =
      Number.isInteger(Number(params.year)) && Number(params.year) > 1900
        ? Number(params.year)
        : new Date().getUTCFullYear();
    const r = await pool.query<{
      tax_category: string;
      total_cents: number;
      txn_count: number;
    }>(
      `SELECT c.tax_category,
              -SUM(l.amount_cents)::bigint AS total_cents,
              COUNT(*)::bigint AS txn_count
         FROM transaction_category_lines l
         JOIN accounts a ON a.id = l.account_id
         JOIN categories c ON c.id = l.category_id
        WHERE a.tenant_id = $1
          AND c.tax_category IS NOT NULL
          AND l.amount_cents < 0
          AND l.transfer_group_id IS NULL
          AND EXTRACT(YEAR FROM l.txn_date) = $2
     GROUP BY c.tax_category
     ORDER BY SUM(l.amount_cents) ASC`,
      [tenantId, year],
    );
    const total = r.rows.reduce((s, row) => s + Number(row.total_cents), 0);
    return {
      columns: [
        { key: 'tax_category', label: 'Schedule C line', type: 'string' },
        { key: 'total_cents', label: 'Total', type: 'cents' },
        { key: 'txn_count', label: 'Transactions', type: 'number' },
      ],
      rows: r.rows.map((row) => ({
        tax_category: row.tax_category,
        total_cents: Number(row.total_cents),
        txn_count: Number(row.txn_count),
      })),
      total_rows: r.rowCount ?? 0,
      summary: `Total deductible: ${fmtUsd(total)}`,
    };
  },
};

/**
 * Savings rate by month. Income, expenses, net, and the savings
 * rate (net / income) as a percentage. The headline personal-
 * finance metric.
 */
const savingsRateByMonth: ReportDefinition = {
  id: 'savings-rate-by-month',
  label: 'Savings rate by month',
  description:
    'Income, expenses, net, and savings rate (% saved of income) for each of the last N months.',
  params: [
    { name: 'months', label: 'Months back', type: 'int', default: '12' },
  ],
  async run(params, tenantId) {
    const months = Math.min(intOr(params, 'months', 12), 60);
    const r = await pool.query<{
      month: string;
      income_cents: number;
      expense_cents: number;
    }>(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', now()) - make_interval(months => $1::int - 1),
           date_trunc('month', now()),
           '1 month'::interval
         )::date AS m
       )
       SELECT to_char(m.m, 'YYYY-MM') AS month,
              COALESCE(SUM(CASE WHEN l.amount_cents > 0 THEN l.amount_cents ELSE 0 END), 0)::bigint AS income_cents,
              -COALESCE(SUM(CASE WHEN l.amount_cents < 0 THEN l.amount_cents ELSE 0 END), 0)::bigint AS expense_cents
         FROM months m
    LEFT JOIN transaction_category_lines l
           ON l.txn_date >= m.m
          AND l.txn_date < (m.m + INTERVAL '1 month')::date
          AND l.transfer_group_id IS NULL
    LEFT JOIN accounts a ON a.id = l.account_id AND a.tenant_id = $2
     GROUP BY m.m
     ORDER BY m.m DESC`,
      [months, tenantId],
    );
    return {
      columns: [
        { key: 'month', label: 'Month', type: 'string' },
        { key: 'income_cents', label: 'Income', type: 'cents' },
        { key: 'expense_cents', label: 'Expenses', type: 'cents' },
        { key: 'net_cents', label: 'Net', type: 'cents' },
        { key: 'savings_rate', label: 'Savings rate', type: 'pct' },
      ],
      rows: r.rows.map((row) => {
        const income = Number(row.income_cents);
        const expense = Number(row.expense_cents);
        const net = income - expense;
        // pct column type expects a decimal (0.30 = 30%).
        const rate = income > 0 ? net / income : null;
        return {
          month: row.month,
          income_cents: income,
          expense_cents: expense,
          net_cents: net,
          savings_rate: rate,
        };
      }),
      total_rows: r.rowCount ?? 0,
    };
  },
};

/**
 * Income sources breakdown. Same shape as spending-by-category but
 * for inflows. Helpful for spotting "interest" / "side income" /
 * "refunds" categories you may not be tagging consistently.
 */
const incomeSourcesBreakdown: ReportDefinition = {
  id: 'income-sources',
  label: 'Income sources breakdown',
  description:
    'Inflows grouped by category over a date range. Surfaces side-income, interest, refunds vs primary salary.',
  params: [
    { name: 'start', label: 'Start date', type: 'date', default: yearAgoIso() },
    { name: 'end', label: 'End date', type: 'date', default: todayIso() },
  ],
  async run(params, tenantId) {
    const start = dateOr(params, 'start', yearAgoIso());
    const end = dateOr(params, 'end', todayIso());
    const r = await pool.query<{
      category_name: string;
      total_cents: number;
      txn_count: number;
    }>(
      `SELECT COALESCE(c.name, 'Uncategorized') AS category_name,
              SUM(l.amount_cents)::bigint AS total_cents,
              COUNT(*)::bigint AS txn_count
         FROM transaction_category_lines l
         JOIN accounts a ON a.id = l.account_id
    LEFT JOIN categories c ON c.id = l.category_id
        WHERE a.tenant_id = $1
          AND l.amount_cents > 0
          AND l.transfer_group_id IS NULL
          AND l.txn_date BETWEEN $2 AND $3
     GROUP BY c.name
     ORDER BY SUM(l.amount_cents) DESC`,
      [tenantId, start, end],
    );
    const total = r.rows.reduce((s, row) => s + Number(row.total_cents), 0);
    return {
      columns: [
        { key: 'category_name', label: 'Source', type: 'string' },
        { key: 'total_cents', label: 'Total', type: 'cents' },
        { key: 'txn_count', label: 'Transactions', type: 'number' },
      ],
      rows: r.rows.map((row) => ({
        category_name: row.category_name,
        total_cents: Number(row.total_cents),
        txn_count: Number(row.txn_count),
      })),
      total_rows: r.rowCount ?? 0,
      summary: `Total income: ${fmtUsd(total)}`,
    };
  },
};

/**
 * First-time merchants. Normalized merchant names whose FIRST
 * transaction (ever) fell inside [start, end]. Catches subscription
 * creep ("when did 'Squarespace' first show up?") and unfamiliar
 * vendors.
 */
const firstTimeMerchants: ReportDefinition = {
  id: 'first-time-merchants',
  label: 'First-time merchants',
  description:
    'New merchants whose first-ever transaction fell in this period. Useful for catching subscription creep.',
  params: [
    { name: 'start', label: 'Start date', type: 'date', default: (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 90);
      return isoDate(d);
    })() },
    { name: 'end', label: 'End date', type: 'date', default: todayIso() },
  ],
  async run(params, tenantId) {
    const ninetyAgo = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 90);
      return isoDate(d);
    })();
    const start = dateOr(params, 'start', ninetyAgo);
    const end = dateOr(params, 'end', todayIso());
    const r = await pool.query<{
      merchant: string;
      first_seen: string;
      total_cents: number;
      txn_count: number;
    }>(
      `WITH first_seen AS (
         SELECT COALESCE(NULLIF(t.normalized_merchant, ''), t.raw_description) AS merchant,
                MIN(t.txn_date) AS first_date
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE a.tenant_id = $1
       GROUP BY 1
       )
       SELECT fs.merchant AS merchant,
              fs.first_date::text AS first_seen,
              -SUM(t.amount_cents)::bigint AS total_cents,
              COUNT(t.id)::bigint AS txn_count
         FROM first_seen fs
         JOIN transactions t
           ON COALESCE(NULLIF(t.normalized_merchant, ''), t.raw_description) = fs.merchant
         JOIN accounts a ON a.id = t.account_id
        WHERE a.tenant_id = $1
          AND fs.first_date BETWEEN $2 AND $3
          AND t.amount_cents < 0
     GROUP BY fs.merchant, fs.first_date
     ORDER BY fs.first_date DESC, ABS(SUM(t.amount_cents)) DESC
        LIMIT 100`,
      [tenantId, start, end],
    );
    return {
      columns: [
        { key: 'merchant', label: 'Merchant', type: 'string' },
        { key: 'first_seen', label: 'First seen', type: 'date' },
        { key: 'total_cents', label: 'Total spent here', type: 'cents' },
        { key: 'txn_count', label: 'Transactions', type: 'number' },
      ],
      rows: r.rows.map((row) => ({
        merchant: row.merchant,
        first_seen: row.first_seen,
        total_cents: Number(row.total_cents),
        txn_count: Number(row.txn_count),
      })),
      total_rows: r.rowCount ?? 0,
    };
  },
};

/**
 * Refunds and chargebacks YTD. Pulls every transaction with a
 * non-null refund_status (0.21.1 tracking). Lets the user see open
 * disputes and closed refunds in one place.
 */
const refundsYtd: ReportDefinition = {
  id: 'refunds-ytd',
  label: 'Refunds & chargebacks YTD',
  description:
    'Every transaction with a refund or chargeback status this year. Open disputes float to the top.',
  params: [
    { name: 'year', label: 'Year', type: 'int', default: String(new Date().getUTCFullYear()) },
  ],
  async run(params, tenantId) {
    const year =
      Number.isInteger(Number(params.year)) && Number(params.year) > 1900
        ? Number(params.year)
        : new Date().getUTCFullYear();
    const r = await pool.query<{
      txn_date: string;
      raw_description: string;
      amount_cents: number;
      refund_status: string;
      refund_note: string | null;
    }>(
      `SELECT t.txn_date::text,
              COALESCE(NULLIF(t.normalized_merchant, ''), t.raw_description) AS raw_description,
              t.amount_cents,
              t.refund_status,
              t.refund_note
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.tenant_id = $1
          AND t.refund_status IS NOT NULL
          AND EXTRACT(YEAR FROM t.txn_date) = $2
     ORDER BY (t.refund_status IN ('refund_pending', 'chargeback_initiated', 'disputed')) DESC,
              t.txn_date DESC`,
      [tenantId, year],
    );
    return {
      columns: [
        { key: 'txn_date', label: 'Date', type: 'date' },
        { key: 'raw_description', label: 'Merchant', type: 'string' },
        { key: 'amount_cents', label: 'Amount', type: 'cents' },
        { key: 'refund_status', label: 'Status', type: 'string' },
        { key: 'refund_note', label: 'Note', type: 'string' },
      ],
      rows: r.rows.map((row) => ({
        ...row,
        amount_cents: Number(row.amount_cents),
        refund_status: row.refund_status.replace('_', ' '),
      })),
      total_rows: r.rowCount ?? 0,
    };
  },
};

/**
 * Bill price drift. Compares each active bill's stated
 * amount_cents to the average of its last 3 matched payments
 * (via bill_periods → transactions). Ranks by absolute drift.
 */
const billPriceDrift: ReportDefinition = {
  id: 'bill-price-drift',
  label: 'Bill price drift',
  description:
    'Active bills whose recent payments deviate from the expected amount. Catches stealth price hikes.',
  params: [],
  async run(_params, tenantId) {
    const r = await pool.query<{
      bill_name: string;
      expected_cents: number;
      avg_actual_cents: number;
      sample_count: number;
    }>(
      `WITH recent_payments AS (
         SELECT b.id AS bill_id,
                b.name AS bill_name,
                b.amount_cents AS expected_cents,
                ABS(t.amount_cents) AS actual_cents,
                bp.period_anchor_date,
                ROW_NUMBER() OVER (PARTITION BY b.id ORDER BY bp.period_anchor_date DESC) AS rn
           FROM bills b
           JOIN bill_periods bp ON bp.bill_id = b.id
           JOIN transactions t ON t.id = bp.matched_txn_id
          WHERE b.tenant_id = $1
            AND b.active = true
            AND bp.status = 'paid'
       )
       SELECT bill_name,
              expected_cents,
              AVG(actual_cents)::bigint AS avg_actual_cents,
              COUNT(*)::bigint AS sample_count
         FROM recent_payments
        WHERE rn <= 3
     GROUP BY bill_id, bill_name, expected_cents
       HAVING ABS(AVG(actual_cents) - expected_cents) > GREATEST(100, expected_cents * 0.02)
     ORDER BY ABS(AVG(actual_cents) - expected_cents) DESC`,
      [tenantId],
    );
    return {
      columns: [
        { key: 'bill_name', label: 'Bill', type: 'string' },
        { key: 'expected_cents', label: 'Expected', type: 'cents' },
        { key: 'avg_actual_cents', label: 'Recent avg', type: 'cents' },
        { key: 'drift_cents', label: 'Drift', type: 'cents' },
        { key: 'sample_count', label: 'Samples', type: 'number' },
      ],
      rows: r.rows.map((row) => {
        const exp = Number(row.expected_cents);
        const act = Number(row.avg_actual_cents);
        return {
          bill_name: row.bill_name,
          expected_cents: exp,
          avg_actual_cents: act,
          drift_cents: act - exp,
          sample_count: Number(row.sample_count),
        };
      }),
      total_rows: r.rowCount ?? 0,
    };
  },
};

/**
 * Debt balance over time. Mirror of net-worth-by-month but
 * filtered to liability accounts only (credit_card, loan,
 * manual_liability), with balances rendered as positive
 * "amount owed" cents.
 */
const debtBalanceByMonth: ReportDefinition = {
  id: 'debt-balance-by-month',
  label: 'Debt balance by month',
  description:
    'Total debt across credit cards + loans + manual liabilities at the end of each month.',
  params: [
    { name: 'months', label: 'Months back', type: 'int', default: '24' },
  ],
  async run(params, tenantId) {
    const months = Math.min(intOr(params, 'months', 24), 120);
    const r = await pool.query<{
      month: string;
      debt_cents: number;
    }>(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', now() - make_interval(months => $1::int)),
           date_trunc('month', now()),
           '1 month'::interval
         )::date AS m
       ),
       openings AS (
         SELECT id, type, opening_balance_cents, opening_balance_date
           FROM accounts
          WHERE tenant_id = $2
            AND type IN ('credit_card', 'loan', 'manual_liability')
       )
       SELECT to_char(m.m, 'YYYY-MM') AS month,
              COALESCE(SUM(
                ABS(o.opening_balance_cents +
                  COALESCE((
                    SELECT SUM(t.amount_cents)
                      FROM transactions t
                     WHERE t.account_id = o.id
                       AND (o.opening_balance_date IS NULL OR t.txn_date >= o.opening_balance_date)
                       AND t.txn_date < (m.m + INTERVAL '1 month')::date
                  ), 0))
              ), 0)::bigint AS debt_cents
         FROM months m
         CROSS JOIN openings o
     GROUP BY m.m
     ORDER BY m.m DESC`,
      [months, tenantId],
    );
    return {
      columns: [
        { key: 'month', label: 'Month', type: 'string' },
        { key: 'debt_cents', label: 'Total debt', type: 'cents' },
      ],
      rows: r.rows.map((row) => ({
        month: row.month,
        debt_cents: Number(row.debt_cents),
      })),
      total_rows: r.rowCount ?? 0,
    };
  },
};

/**
 * Average transaction by category. Count, sum, average per
 * category over a date range. Useful for budget calibration —
 * "I average 18 grocery trips a month at $74 each."
 */
const avgTxnByCategory: ReportDefinition = {
  id: 'avg-txn-by-category',
  label: 'Average transaction by category',
  description:
    'Count, total, and average transaction size per category. Useful for setting realistic budgets.',
  params: [
    { name: 'start', label: 'Start date', type: 'date', default: (() => {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() - 3);
      return isoDate(d);
    })() },
    { name: 'end', label: 'End date', type: 'date', default: todayIso() },
  ],
  async run(params, tenantId) {
    const ninetyAgo = (() => {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() - 3);
      return isoDate(d);
    })();
    const start = dateOr(params, 'start', ninetyAgo);
    const end = dateOr(params, 'end', todayIso());
    const r = await pool.query<{
      category_name: string;
      txn_count: number;
      total_cents: number;
      avg_cents: number;
    }>(
      `SELECT COALESCE(c.name, 'Uncategorized') AS category_name,
              COUNT(*)::bigint AS txn_count,
              -SUM(l.amount_cents)::bigint AS total_cents,
              -AVG(l.amount_cents)::bigint AS avg_cents
         FROM transaction_category_lines l
         JOIN accounts a ON a.id = l.account_id
    LEFT JOIN categories c ON c.id = l.category_id
        WHERE a.tenant_id = $1
          AND l.amount_cents < 0
          AND l.transfer_group_id IS NULL
          AND l.txn_date BETWEEN $2 AND $3
     GROUP BY c.name
     ORDER BY SUM(l.amount_cents) ASC`,
      [tenantId, start, end],
    );
    return {
      columns: [
        { key: 'category_name', label: 'Category', type: 'string' },
        { key: 'txn_count', label: 'Count', type: 'number' },
        { key: 'total_cents', label: 'Total', type: 'cents' },
        { key: 'avg_cents', label: 'Average', type: 'cents' },
      ],
      rows: r.rows.map((row) => ({
        category_name: row.category_name,
        txn_count: Number(row.txn_count),
        total_cents: Number(row.total_cents),
        avg_cents: Number(row.avg_cents),
      })),
      total_rows: r.rowCount ?? 0,
    };
  },
};


const REPORTS: ReportDefinition[] = [
  spendingByCategory,
  topMerchants,
  monthlyIncomeExpense,
  subscriptionCosts,
  largestTransactions,
  netWorthByMonth,
  // 0.24.4 — additional reports
  yearOverYearByCategory,
  monthlyMovers,
  dayOfWeekPattern,
  taxDeductibleYtd,
  savingsRateByMonth,
  incomeSourcesBreakdown,
  firstTimeMerchants,
  refundsYtd,
  billPriceDrift,
  debtBalanceByMonth,
  avgTxnByCategory,
];

export function listReports(): Array<{
  id: string;
  label: string;
  description: string;
  params: ReportParamDef[];
}> {
  return REPORTS.map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description,
    params: r.params,
  }));
}

export function getReport(id: string): ReportDefinition | null {
  return REPORTS.find((r) => r.id === id) ?? null;
}
