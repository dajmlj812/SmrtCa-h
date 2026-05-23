import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  api,
  type IncomeExpenseRow,
  type NetWorthRow,
  type SpendingByCategoryRow,
} from '../api';
import { formatCents } from '../format';

// Recharts Tooltip's formatter widens `value` to ValueType | undefined; these
// wrappers narrow it back to the numbers we know we put in.
const tooltipCents = (v: unknown): string =>
  typeof v === 'number' ? formatCents(v) : '';
const tooltipDollarsToCents = (v: unknown): string =>
  typeof v === 'number' ? formatCents(v * 100) : '';

// A muted, distinguishable palette — tuned for both light and dark backgrounds.
const PIE_COLORS = [
  '#4f8cff', '#ff7b54', '#52c41a', '#faad14', '#9254de',
  '#13c2c2', '#eb2f96', '#f5222d', '#a0d911', '#fa8c16',
  '#1890ff', '#fadb14',
];

interface DashboardData {
  spending: SpendingByCategoryRow[];
  spendingStart: string;
  spendingEnd: string;
  incomeExpense: IncomeExpenseRow[];
  netWorth: NetWorthRow[];
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [spending, incomeExpense, netWorth] = await Promise.all([
          api.spendingByCategory({}),
          api.incomeExpense({ months: 12 }),
          api.netWorthOverTime({ months: 12 }),
        ]);
        setData({
          spending: spending.rows,
          spendingStart: spending.start,
          spendingEnd: spending.end,
          incomeExpense: incomeExpense.rows,
          netWorth: netWorth.rows,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <p className="empty">Loading dashboard…</p>;
  if (error) return <div className="banner error">{error}</div>;
  if (!data) return null;

  // Roll the spending data up by parent group for the pie — top-level
  // categories make a more readable chart than ~190 leaf categories.
  const byParent = new Map<string, number>();
  for (const row of data.spending) {
    const key = row.parent_name ?? row.category_name ?? 'Uncategorized';
    byParent.set(key, (byParent.get(key) ?? 0) + row.total_cents);
  }
  const pieData = Array.from(byParent.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const totalSpending = pieData.reduce((sum, p) => sum + p.value, 0);

  const incomeExpenseChart = data.incomeExpense.map((r) => ({
    month: r.month,
    Income: r.income_cents / 100,
    Expense: r.expense_cents / 100,
  }));
  const netWorthChart = data.netWorth.map((r) => ({
    month: r.month,
    NetWorth: r.net_worth_cents / 100,
  }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <div className="subtitle">
            Spending, cash flow, and net worth at a glance. Transfers between
            your own accounts are excluded from spending and income.
          </div>
        </div>
      </div>

      <div className="chart-grid">
        <div className="card chart-card">
          <div className="chart-title">
            Spending this month{' '}
            <span className="muted">
              ({data.spendingStart} → {data.spendingEnd})
            </span>
          </div>
          {pieData.length === 0 ? (
            <p className="empty">No spending in this period yet.</p>
          ) : (
            <>
              <div className="chart-headline">
                <span className="muted">Total</span>{' '}
                <strong>{formatCents(totalSpending)}</strong>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    outerRadius={100}
                    label={(entry: { name?: string }) => entry.name ?? ''}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={tooltipCents}
                  />
                </PieChart>
              </ResponsiveContainer>
            </>
          )}
        </div>

        <div className="card chart-card">
          <div className="chart-title">Income vs. expense (last 12 months)</div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={incomeExpenseChart}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="month" />
              <YAxis tickFormatter={(v) => `$${Math.round(v)}`} />
              <Tooltip formatter={tooltipDollarsToCents} />
              <Legend />
              <Bar dataKey="Income" fill="#52c41a" />
              <Bar dataKey="Expense" fill="#ff7b54" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card chart-card chart-card-wide">
          <div className="chart-title">Net worth over time (last 12 months)</div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={netWorthChart}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="month" />
              <YAxis tickFormatter={(v) => `$${Math.round(v)}`} />
              <Tooltip formatter={tooltipDollarsToCents} />
              <Line
                type="monotone"
                dataKey="NetWorth"
                stroke="#4f8cff"
                strokeWidth={2}
                dot
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
