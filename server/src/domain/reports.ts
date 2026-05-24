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
         SELECT id, opening_balance_cents, opening_balance_date
           FROM accounts
          WHERE tenant_id = $2
       )
       SELECT to_char(m.m, 'YYYY-MM') AS month,
              COALESCE(SUM(o.opening_balance_cents +
                COALESCE((
                  SELECT SUM(t.amount_cents)
                    FROM transactions t
                   WHERE t.account_id = o.id
                     AND (o.opening_balance_date IS NULL OR t.txn_date >= o.opening_balance_date)
                     AND t.txn_date < (m.m + interval '1 month')::date
                ), 0)
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

const REPORTS: ReportDefinition[] = [
  spendingByCategory,
  topMerchants,
  monthlyIncomeExpense,
  subscriptionCosts,
  largestTransactions,
  netWorthByMonth,
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
