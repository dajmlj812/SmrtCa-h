import { useEffect, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  api,
  type Bill,
  type IncomeExpenseRow,
  type NetWorthRow,
  type SpendingByCategoryRow,
} from '../api';
import { formatCents, formatDate } from '../format';

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
  upcomingBills: Bill[];
  cashFlow: Array<{
    date: string;
    projected_cents: number;
    low_cents: number;
    high_cents: number;
  }>;
  cashFlowStart: number;
  cashFlowEnd: number;
  cashFlowVolatility: number;
  cashFlowMilestones: { day_30: number; day_60: number; day_90: number };
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [spending, incomeExpense, netWorth, upcoming, flow] =
          await Promise.all([
            api.spendingByCategory({}),
            api.incomeExpense({ months: 12 }),
            api.netWorthOverTime({ months: 12 }),
            api.upcomingBills(30),
            api.cashFlow(90),
          ]);
        setData({
          spending: spending.rows,
          spendingStart: spending.start,
          spendingEnd: spending.end,
          incomeExpense: incomeExpense.rows,
          netWorth: netWorth.rows,
          upcomingBills: upcoming.bills,
          cashFlow: flow.series,
          cashFlowStart: flow.starting_cents,
          cashFlowEnd: flow.ending_cents,
          cashFlowVolatility: flow.daily_volatility_cents,
          cashFlowMilestones: flow.milestones,
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

  // 0.18.0 — cash-flow forecast is the dashboard hero. We render the
  // existing 90-day projection with a stddev-based confidence band
  // (Recharts requires a single key for the area, so we pre-compute
  // `Band: [low, high]` as a tuple).
  const cashFlowChart = data.cashFlow.map((p) => ({
    date: p.date,
    Projected: p.projected_cents / 100,
    Band: [p.low_cents / 100, p.high_cents / 100] as [number, number],
  }));
  const ms = data.cashFlowMilestones;
  const milestoneClass = (cents: number, baseline: number) =>
    cents >= baseline ? 'milestone-up' : 'milestone-down';

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

      <div className="card chart-card cashflow-hero">
        <div className="cashflow-hero-header">
          <div>
            <div className="chart-title">Cash-flow forecast · next 90 days</div>
            <div className="muted cashflow-hero-sub">
              Starting balance {formatCents(data.cashFlowStart)} · shaded
              band reflects ±1σ of recent daily volatility
              {data.cashFlowVolatility > 0
                ? ` (${formatCents(data.cashFlowVolatility)}/day)`
                : ''}
            </div>
          </div>
          <div className="cashflow-milestones">
            <div className={`milestone ${milestoneClass(ms.day_30, data.cashFlowStart)}`}>
              <div className="milestone-label">30 days</div>
              <div className="milestone-value">{formatCents(ms.day_30)}</div>
            </div>
            <div className={`milestone ${milestoneClass(ms.day_60, data.cashFlowStart)}`}>
              <div className="milestone-label">60 days</div>
              <div className="milestone-value">{formatCents(ms.day_60)}</div>
            </div>
            <div className={`milestone ${milestoneClass(ms.day_90, data.cashFlowStart)}`}>
              <div className="milestone-label">90 days</div>
              <div className="milestone-value">{formatCents(ms.day_90)}</div>
            </div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={cashFlowChart}>
            <defs>
              <linearGradient id="cashflow-band" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#52c41a" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#52c41a" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey="date" minTickGap={40} />
            <YAxis tickFormatter={(v) => `$${Math.round(v)}`} />
            <Tooltip
              formatter={(value: unknown, name: unknown) => {
                if (name === 'Band' && Array.isArray(value)) {
                  const [lo, hi] = value as [number, number];
                  return [
                    `${formatCents(lo * 100)} – ${formatCents(hi * 100)}`,
                    'Range',
                  ];
                }
                return [tooltipDollarsToCents(value), String(name ?? '')];
              }}
            />
            <ReferenceLine y={0} stroke="#ff7b54" strokeDasharray="4 4" />
            <Area
              type="monotone"
              dataKey="Band"
              stroke="none"
              fill="url(#cashflow-band)"
              isAnimationActive={false}
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="Projected"
              stroke="#52c41a"
              strokeWidth={2.5}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
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

        <div className="card chart-card">
          <div className="chart-title">Upcoming bills (next 30 days)</div>
          {data.upcomingBills.length === 0 ? (
            <p className="empty">No bills scheduled in the window.</p>
          ) : (
            <ul className="upcoming-bills">
              {data.upcomingBills.map((b) => (
                <li key={b.id}>
                  <span className="upcoming-bill-name">{b.name}</span>
                  <span className="muted upcoming-bill-date">
                    {formatDate(b.next_due_date)}
                  </span>
                  <span className="num neg">{formatCents(-b.amount_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
