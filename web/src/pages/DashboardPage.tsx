import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import { Link } from 'react-router-dom';
import {
  Responsive,
  WidthProvider,
  type Layout,
  type Layouts,
} from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

// react-grid-layout's <Responsive> needs to know its container width
// to compute item positions. Without WidthProvider it falls back to
// a hardcoded 1280px assumption and items overlay each other when
// the actual container is narrower. WidthProvider measures the
// element on mount + resize and feeds the value in as a prop.
const ResponsiveGridLayout = WidthProvider(Responsive);
import {
  api,
  type Bill,
  type IncomeExpenseRow,
  type NetWorthRow,
  type SavingsGoal,
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
  goals: SavingsGoal[];
}

// 0.18.14 — widget registry. The dashboard is a 2D grid of these
// widgets; users can drag, resize, hide, and re-show each independently.
// Adding a new widget = adding a row here. The `defaultLayout` is what
// new users see; existing users keep their saved layout.
//
// Grid units: 12 cols wide on desktop. We size everything in those
// units. heights: 1 unit = 60px (rowHeight) — so h:7 ≈ 420px.
interface WidgetDef {
  id: string;
  title: string;
  defaultLayout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number };
}

// Default layout — vertical flow tuned so the hero + two side-by-side
// charts fit in the initial viewport on a 1440px desktop. Heights are
// in row units (1 row = 60px + 16px margin). Lists (goals + bills)
// get shorter heights since they're naturally compact.
const WIDGETS: WidgetDef[] = [
  { id: 'cashflow-hero',  title: 'Cash-flow forecast', defaultLayout: { x: 0, y: 0,  w: 12, h: 6, minW: 6, minH: 4 } },
  { id: 'spending-pie',   title: 'Spending this month', defaultLayout: { x: 0, y: 6,  w: 6,  h: 5, minW: 3, minH: 3 } },
  { id: 'income-expense', title: 'Income vs. expense', defaultLayout: { x: 6, y: 6,  w: 6,  h: 5, minW: 3, minH: 3 } },
  { id: 'net-worth',      title: 'Net worth',           defaultLayout: { x: 0, y: 11, w: 12, h: 5, minW: 4, minH: 3 } },
  { id: 'savings-goals',  title: 'Top savings goals',   defaultLayout: { x: 0, y: 16, w: 6,  h: 4, minW: 3, minH: 3 } },
  { id: 'upcoming-bills', title: 'Upcoming bills',      defaultLayout: { x: 6, y: 16, w: 6,  h: 4, minW: 3, minH: 3 } },
];

function defaultLayout(): Layout[] {
  return WIDGETS.map((w) => ({ i: w.id, ...w.defaultLayout }));
}

function asLayouts(items: Layout[]): Layouts {
  // v1 Layouts is { [breakpoint]: Layout[] } where Layout is the
  // single-item type.
  return { lg: items, md: items, sm: items, xs: items, xxs: items };
}

const ROW_HEIGHT = 60;
const BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 };
const RESPONSIVE_COLS = { lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 };

interface SavedPrefs {
  layout?: Layout[];
  hidden?: string[];
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Layout + visibility state. Both are persisted per user. We
  // initialize to the defaults, then overlay the server values on
  // mount — that way the dashboard always renders something even
  // if the prefs fetch is slow or fails.
  const [layout, setLayout] = useState<Layout[]>(() => defaultLayout());
  const [hidden, setHidden] = useState<string[]>([]);
  const [editMode, setEditMode] = useState(false);
  const saveTimer = useRef<number | null>(null);
  // After the very first prefs fetch we start saving on layout changes.
  // Before that, any layout-change call from RGL is just the initial
  // mount and we mustn't echo it back to the server — that would
  // overwrite a saved layout with defaults during the race window
  // between mount and prefs-fetch.
  const initialized = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        // Fetch all dashboard data + user prefs in parallel. Prefs is
        // a tiny query — no point sequencing it.
        const [spending, incomeExpense, netWorth, upcoming, flow, goals, prefs] =
          await Promise.all([
            api.spendingByCategory({}),
            api.incomeExpense({ months: 12 }),
            api.netWorthOverTime({ months: 12 }),
            api.upcomingBills(30),
            api.cashFlow(90),
            api.listGoals(),
            api.getPreferences().catch(() => ({} as Record<string, unknown>)),
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
          goals,
        });
        // Apply saved prefs if they exist + look valid (filter out any
        // widget IDs we don't know about — they're either renamed or
        // removed since the user last saved).
        const dash = (prefs as { dashboard?: SavedPrefs }).dashboard;
        if (dash) {
          const known = new Set(WIDGETS.map((w) => w.id));
          if (Array.isArray(dash.layout)) {
            const filtered = dash.layout.filter((l) => known.has(l.i));
            // For any widget the user has never seen (added since they
            // last saved), append it with its default coords.
            const seenIds = new Set(filtered.map((l) => l.i));
            const additions = WIDGETS.filter((w) => !seenIds.has(w.id)).map(
              (w) => ({ i: w.id, ...w.defaultLayout }),
            );
            setLayout([...filtered, ...additions]);
          }
          if (Array.isArray(dash.hidden)) {
            setHidden(dash.hidden.filter((id) => known.has(id)));
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load dashboard');
      } finally {
        setLoading(false);
        // Defer the "initialized" flag a tick so the first
        // RGL onLayoutChange (which fires synchronously on mount)
        // doesn't trigger a save.
        setTimeout(() => { initialized.current = true; }, 0);
      }
    })();
  }, []);

  // Debounced save: every layout/hidden change schedules a PUT 500ms
  // out, with later changes resetting the timer. Avoids hammering
  // the server while the user is mid-drag.
  function scheduleSave(nextLayout: Layout[], nextHidden: string[]): void {
    if (!initialized.current) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api
        .putDashboardLayout({
          layout: { lg: nextLayout } as unknown as Record<string, unknown>,
          hidden: nextHidden,
        })
        .catch(() => {
          // Don't surface — silent retry on next change. The user's
          // browser still shows the layout they expect; we just
          // failed to persist this revision.
        });
    }, 500);
  }

  function handleLayoutChange(next: Layout[]): void {
    setLayout(next);
    scheduleSave(next, hidden);
  }

  function hideWidget(id: string): void {
    const next = [...hidden, id];
    setHidden(next);
    scheduleSave(layout, next);
  }

  function showWidget(id: string): void {
    const next = hidden.filter((h) => h !== id);
    setHidden(next);
    scheduleSave(layout, next);
  }

  function resetLayout(): void {
    setLayout(defaultLayout());
    setHidden([]);
    void api.resetDashboardLayout().catch(() => {});
  }

  if (loading) return <p className="empty">Loading dashboard…</p>;
  if (error) return <div className="banner error">{error}</div>;
  if (!data) return null;

  // Compute derived chart datasets up front — these are reused inside
  // the widget renderers below.
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
  const cashFlowChart = data.cashFlow.map((p) => ({
    date: p.date,
    Projected: p.projected_cents / 100,
    Band: [p.low_cents / 100, p.high_cents / 100] as [number, number],
  }));
  const ms = data.cashFlowMilestones;
  const milestoneClass = (cents: number, baseline: number) =>
    cents >= baseline ? 'milestone-up' : 'milestone-down';

  // Widget content registry. Each value is a function returning the
  // INNER content of the card — the WidgetFrame below adds the
  // shared chrome (title, drag handle, hide button in edit mode).
  const renderers: Record<string, () => ReactNode> = {
    'cashflow-hero': () => (
      <>
        <div className="cashflow-hero-header">
          <div>
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
        <div className="widget-chart">
        <ResponsiveContainer width="100%" height="100%">
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
      </>
    ),

    'spending-pie': () => (
      pieData.length === 0 ? (
        <p className="empty">No spending in this period yet.</p>
      ) : (
        <>
          <div className="chart-headline">
            <span className="muted">Total</span>{' '}
            <strong>{formatCents(totalSpending)}</strong>{' '}
            <span className="muted small">
              ({data.spendingStart} → {data.spendingEnd})
            </span>
          </div>
          <div className="widget-chart">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                outerRadius="80%"
                label={(entry: { name?: string }) => entry.name ?? ''}
              >
                {pieData.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={tooltipCents} />
            </PieChart>
          </ResponsiveContainer>
          </div>
        </>
      )
    ),

    'income-expense': () => (
      <div className="widget-chart">
      <ResponsiveContainer width="100%" height="100%">
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
    ),

    'net-worth': () => (
      <div className="widget-chart">
      <ResponsiveContainer width="100%" height="100%">
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
    ),

    'savings-goals': () => (
      data.goals.length === 0 ? (
        <p className="empty">
          No goals yet. <Link to="/goals">Create your first goal</Link>.
        </p>
      ) : (
        <ul className="dashboard-goals">
          {data.goals.slice(0, 3).map((g) => {
            const pct = Math.round(Number(g.progress) * 100);
            return (
              <li key={g.id}>
                <div className="dashboard-goal-row">
                  <span className="dashboard-goal-name">{g.name}</span>
                  <span className="muted">
                    {formatCents(g.current_amount_cents)} /{' '}
                    {formatCents(g.target_amount_cents)}
                  </span>
                </div>
                <div className={`progress-track ${pct >= 100 ? 'progress-track-done' : ''}`}>
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
                <div className="muted small">
                  {pct}% complete
                  {g.target_date && <> · target {formatDate(g.target_date)}</>}
                </div>
              </li>
            );
          })}
        </ul>
      )
    ),

    'upcoming-bills': () => (
      data.upcomingBills.length === 0 ? (
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
      )
    ),
  };

  const visibleWidgets = WIDGETS.filter((w) => !hidden.includes(w.id));
  const visibleLayout = layout.filter((l) => !hidden.includes(l.i));
  const hiddenWidgets = WIDGETS.filter((w) => hidden.includes(w.id));

  return (
    <div className={`dashboard-shell ${editMode ? 'is-editing' : ''}`}>
      <div className="page-header dashboard-page-header">
        <div>
          <h1>Dashboard</h1>
          <div className="subtitle">
            Spending, cash flow, and net worth at a glance. Transfers between
            your own accounts are excluded from spending and income.
          </div>
        </div>
        <div className="dashboard-page-actions">
          {editMode && (
            <button className="btn-link" type="button" onClick={resetLayout}>
              Reset to default
            </button>
          )}
          <button
            className={`btn ${editMode ? 'btn-primary' : ''}`}
            type="button"
            onClick={() => setEditMode((e) => !e)}
          >
            {editMode ? 'Done' : 'Customize'}
          </button>
        </div>
      </div>

      {editMode && hiddenWidgets.length > 0 && (
        <div className="dashboard-hidden-tray">
          <span className="muted small">Hidden widgets:</span>
          {hiddenWidgets.map((w) => (
            <button
              key={w.id}
              className="pill pill-action"
              type="button"
              onClick={() => showWidget(w.id)}
            >
              + {w.title}
            </button>
          ))}
        </div>
      )}

      <ResponsiveGridLayout
        className="dashboard-grid"
        layouts={asLayouts(visibleLayout)}
        breakpoints={BREAKPOINTS}
        cols={RESPONSIVE_COLS}
        rowHeight={ROW_HEIGHT}
        margin={[16, 16]}
        containerPadding={[0, 0]}
        isDraggable={editMode}
        isResizable={editMode}
        compactType="vertical"
        draggableHandle=".widget-drag-handle"
        onLayoutChange={handleLayoutChange}
      >
        {visibleWidgets.map((w) => (
          <div key={w.id} className="card chart-card widget-card">
            <div className="widget-header">
              <div
                className={`chart-title widget-title ${editMode ? 'widget-drag-handle' : ''}`}
              >
                {w.title}
              </div>
              {editMode && (
                <button
                  className="widget-hide-btn"
                  type="button"
                  onClick={() => hideWidget(w.id)}
                  title="Hide widget"
                  aria-label={`Hide ${w.title}`}
                >
                  ×
                </button>
              )}
            </div>
            <div className="widget-body">
              {renderers[w.id]?.()}
            </div>
          </div>
        ))}
      </ResponsiveGridLayout>
    </div>
  );
}
