import { useEffect, useState } from 'react';
import {
  Area,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  api,
  type AssetClass,
  type InvestmentAnalysis,
  type MonteCarloResult,
} from '../api';
import { formatCents } from '../format';

/**
 * 0.19.3 — Investments analysis page.
 *
 * Three Empower-class views on the existing holdings + projections:
 *   • Fee analyzer (annual fee drag + 30-year opportunity cost)
 *   • Asset allocation pie + deviation table
 *   • Monte Carlo on retirement projections (5k trials, p10/p50/p90)
 */

const CLASS_LABELS: Record<AssetClass, string> = {
  stocks: 'Stocks',
  bonds: 'Bonds',
  cash: 'Cash',
  alts: 'Alts (crypto, commodities)',
  real_estate: 'Real estate',
};

const CLASS_COLORS: Record<AssetClass, string> = {
  stocks: '#4f8cff',
  bonds: '#52c41a',
  cash: '#13c2c2',
  alts: '#9254de',
  real_estate: '#fa8c16',
};

export function InvestmentsPage() {
  const [analysis, setAnalysis] = useState<InvestmentAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Monte Carlo state
  const [projections, setProjections] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProjId, setSelectedProjId] = useState<string>('');
  const [stddev, setStddev] = useState<string>('15');
  const [trials, setTrials] = useState<string>('5000');
  const [mc, setMc] = useState<MonteCarloResult | null>(null);
  const [mcLoading, setMcLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [a, p] = await Promise.all([
          api.getInvestmentAnalysis(),
          api.listProjections(),
        ]);
        setAnalysis(a);
        setProjections(p.map((proj) => ({ id: proj.id, name: proj.name })));
        if (p.length > 0) setSelectedProjId(p[0]!.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load analysis');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function runMc() {
    if (!selectedProjId) return;
    setMcLoading(true);
    setError(null);
    try {
      const r = await api.runMonteCarlo(selectedProjId, {
        stddevPct: Number(stddev),
        trials: Number(trials),
      });
      setMc(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Monte Carlo failed');
    } finally {
      setMcLoading(false);
    }
  }

  if (loading) return <p className="empty">Loading…</p>;
  if (error && !analysis) return <div className="banner error">{error}</div>;
  if (!analysis) return null;

  const { fees, allocation, holding_count } = analysis;

  // Pie data filters out empty buckets for cleanliness.
  const pieData = allocation.buckets
    .filter((b) => b.value_cents > 0)
    .map((b) => ({
      name: CLASS_LABELS[b.asset_class],
      value: b.value_cents / 100,
      pct: b.pct,
      color: CLASS_COLORS[b.asset_class],
    }));

  // Monte Carlo chart data — combine the percentile bands into one
  // dataset so Recharts can render a stacked area + median line.
  const mcChart = mc
    ? mc.points.map((p) => ({
        year: p.year,
        p10: p.p10_nominal_cents / 100,
        p50: p.p50_nominal_cents / 100,
        p90: p.p90_nominal_cents / 100,
        // pre-computed band for the shaded area
        band: [p.p10_nominal_cents / 100, p.p90_nominal_cents / 100] as [number, number],
      }))
    : [];

  return (
    <div className="page-content investments-page">
      <header className="page-header">
        <h1>Investments</h1>
        <p className="subtitle muted small">
          {holding_count} {holding_count === 1 ? 'holding' : 'holdings'} across your
          accounts. Set <strong>expense ratio</strong> + <strong>asset class</strong>{' '}
          on each holding to unlock the full analysis.
        </p>
      </header>

      {error && <div className="banner error">{error}</div>}

      {/* ── Fee analyzer ──────────────────────────── */}
      <section className="card">
        <h2>Fee drag</h2>
        <div className="investments-stat-row">
          <div className="investments-stat">
            <div className="muted small">Portfolio value</div>
            <strong>{formatCents(fees.total_value_cents)}</strong>
          </div>
          <div className="investments-stat">
            <div className="muted small">Annual fees</div>
            <strong>{formatCents(fees.annual_fee_cents)}</strong>
          </div>
          <div className="investments-stat">
            <div className="muted small">Weighted avg expense %</div>
            <strong>{fees.weighted_avg_expense_ratio_pct.toFixed(3)}%</strong>
          </div>
          <div className="investments-stat investments-stat-warn">
            <div className="muted small">30-year opportunity cost</div>
            <strong>{formatCents(fees.thirty_year_opportunity_cost_cents)}</strong>
          </div>
        </div>

        {fees.unknown_ratio_count > 0 && (
          <p className="callout warn small">
            <strong>{fees.unknown_ratio_count}</strong> holdings
            ({formatCents(fees.unknown_ratio_value_cents)}) have no expense ratio
            set — they're excluded from the math above. Set their expense %
            in the holdings table on each account to include them.
          </p>
        )}

        {fees.top_fee_drags.length > 0 && (
          <>
            <h3 className="muted small">Biggest contributors</h3>
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Holding</th>
                  <th className="num">Value</th>
                  <th className="num">Expense %</th>
                  <th className="num">Annual fee</th>
                </tr>
              </thead>
              <tbody>
                {fees.top_fee_drags.map((f) => (
                  <tr key={f.holding_id}>
                    <td>
                      {f.symbol ? <strong>{f.symbol}</strong> : null}{' '}
                      <span className="muted">{f.name}</span>
                    </td>
                    <td className="num">{formatCents(f.value_cents)}</td>
                    <td className="num">{f.expense_ratio_pct.toFixed(3)}%</td>
                    <td className="num">{formatCents(f.annual_fee_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {/* ── Asset allocation ─────────────────────── */}
      <section className="card">
        <h2>Asset allocation</h2>
        {allocation.derived_class_count > 0 && (
          <p className="muted small">
            {allocation.derived_class_count} of {holding_count} holdings have no
            asset class set — they're bucketed by a default derived from their
            Type (stock/etf/mutual_fund → stocks, bond → bonds, crypto → alts).
            Override per-holding for accuracy.
          </p>
        )}

        {pieData.length === 0 ? (
          <p className="empty">No holdings with non-zero value.</p>
        ) : (
          <div className="investments-allocation">
            <div className="investments-pie">
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    outerRadius={100}
                    label={(entry: { name?: string; pct?: number }) =>
                      `${entry.name} ${(entry.pct ?? 0).toFixed(1)}%`
                    }
                  >
                    {pieData.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: unknown) =>
                      typeof v === 'number' ? formatCents(v * 100) : ''
                    }
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th className="num">Value</th>
                  <th className="num">% of portfolio</th>
                </tr>
              </thead>
              <tbody>
                {allocation.buckets.map((b) => (
                  <tr key={b.asset_class}>
                    <td>
                      <span
                        className="allocation-swatch"
                        style={{ background: CLASS_COLORS[b.asset_class] }}
                      />
                      {CLASS_LABELS[b.asset_class]}
                    </td>
                    <td className="num">{formatCents(b.value_cents)}</td>
                    <td className="num">{b.pct.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Monte Carlo retirement ──────────────── */}
      <section className="card">
        <h2>Retirement Monte Carlo</h2>
        <p className="muted small">
          Runs N trials of the projection with a random annual return drawn
          from a normal distribution. The shaded band is the 10th-90th
          percentile range; the line is the median outcome.
        </p>

        {projections.length === 0 ? (
          <p className="empty">
            No retirement projections set up. Create one on the Projections
            page first.
          </p>
        ) : (
          <>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="mc-proj">Projection</label>
                <select
                  id="mc-proj"
                  value={selectedProjId}
                  onChange={(e) => setSelectedProjId(e.target.value)}
                >
                  {projections.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="mc-stddev">Annual stddev (%)</label>
                <input
                  id="mc-stddev"
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={stddev}
                  onChange={(e) => setStddev(e.target.value)}
                  title="Typical equity portfolio: 15-18%. 60/40 portfolio: 10-12%. All bonds: 5-7%."
                />
              </div>
              <div className="field">
                <label htmlFor="mc-trials">Trials</label>
                <input
                  id="mc-trials"
                  type="number"
                  step="1000"
                  min="100"
                  max="20000"
                  value={trials}
                  onChange={(e) => setTrials(e.target.value)}
                />
              </div>
              <div className="field" style={{ alignSelf: 'end' }}>
                <button
                  type="button"
                  className="btn"
                  disabled={mcLoading || !selectedProjId}
                  onClick={() => void runMc()}
                >
                  {mcLoading ? 'Running…' : 'Run Monte Carlo'}
                </button>
              </div>
            </div>

            {mc && (
              <>
                {typeof mc.prob_meet_target === 'number' && (
                  <p
                    className={`callout ${mc.prob_meet_target >= 0.8 ? '' : mc.prob_meet_target >= 0.5 ? 'warn' : 'error'}`}
                  >
                    Probability of meeting target:{' '}
                    <strong>{(mc.prob_meet_target * 100).toFixed(1)}%</strong>{' '}
                    across {mc.trials} trials.
                  </p>
                )}
                <ResponsiveContainer width="100%" height={340}>
                  <ComposedChart data={mcChart}>
                    <defs>
                      <linearGradient id="mc-band" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#4f8cff" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#4f8cff" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="year" />
                    <YAxis tickFormatter={(v) => `$${Math.round(v / 1000)}K`} />
                    <Tooltip
                      formatter={(value: unknown, name: unknown) => {
                        if (name === 'band' && Array.isArray(value)) {
                          const [lo, hi] = value as [number, number];
                          return [
                            `${formatCents(lo * 100)} – ${formatCents(hi * 100)}`,
                            '10th-90th',
                          ];
                        }
                        return [
                          typeof value === 'number' ? formatCents(value * 100) : '',
                          String(name ?? ''),
                        ];
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="band"
                      stroke="none"
                      fill="url(#mc-band)"
                      isAnimationActive={false}
                      activeDot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="p50"
                      stroke="#4f8cff"
                      strokeWidth={2.5}
                      dot={false}
                      name="Median"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
