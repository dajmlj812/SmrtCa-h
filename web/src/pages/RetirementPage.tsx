import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  api,
  isUpgradeRequired,
  type ProjectionSeries,
  type RetirementProjection,
} from '../api';
import { formatCents } from '../format';
import { UpgradePrompt } from '../components/UpgradePrompt';

/**
 * /retirement — long-term goal projections.
 *
 * Each projection captures: starting balance, monthly contribution,
 * annual return rate, optional inflation deflator, horizon in years,
 * optional target (year + amount, drawn as a horizontal reference
 * line on the chart). The series API returns one point per year
 * (year 0 = starting state).
 */

export function RetirementPage() {
  const [projections, setProjections] = useState<RetirementProjection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [series, setSeries] = useState<ProjectionSeries | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsUpgrade, setNeedsUpgrade] = useState(false);

  async function load() {
    setLoading(true);
    setNeedsUpgrade(false);
    try {
      const list = await api.listProjections();
      setProjections(list);
      if (list.length > 0 && !activeId) setActiveId(list[0]!.id);
      setError(null);
    } catch (e) {
      if (isUpgradeRequired(e)) {
        setNeedsUpgrade(true);
      } else {
        setError(e instanceof Error ? e.message : 'Failed to load');
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!activeId) {
      setSeries(null);
      return;
    }
    api
      .projectionSeries(activeId)
      .then(setSeries)
      .catch((e) =>
        setError(e instanceof Error ? e.message : 'Failed to compute series'),
      );
  }, [activeId]);

  async function remove(id: string) {
    if (!window.confirm('Delete this projection?')) return;
    try {
      await api.deleteProjection(id);
      if (activeId === id) setActiveId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const active = useMemo(
    () => projections.find((p) => p.id === activeId) ?? null,
    [projections, activeId],
  );

  if (needsUpgrade) {
    return (
      <div>
        <div className="page-header"><h1>Retirement &amp; long-term goals</h1></div>
        <UpgradePrompt feature="Retirement projections" requiredPlan="plus" />
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Retirement &amp; long-term goals</h1>
          <div className="subtitle">
            Projects your balance forward year by year using monthly-compound
            growth + a configurable inflation deflator.
          </div>
        </div>
        <button
          className="btn"
          type="button"
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? 'Cancel' : 'New projection'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {showForm && (
        <ProjectionForm
          onSaved={(p) => {
            setShowForm(false);
            setActiveId(p.id);
            void load();
          }}
        />
      )}

      <div className="reports-layout">
        <aside className="reports-list">
          {loading ? (
            <p className="empty">Loading…</p>
          ) : projections.length === 0 ? (
            <p className="empty">No projections yet.</p>
          ) : (
            projections.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`reports-list-item ${p.id === activeId ? 'active' : ''}`}
                onClick={() => setActiveId(p.id)}
              >
                <strong>{p.name}</strong>
                <span className="muted">
                  {formatCents(p.starting_balance_cents)} start ·{' '}
                  {formatCents(p.monthly_contribution_cents)}/mo ·{' '}
                  {Number(p.annual_return_pct).toFixed(1)}% return ·{' '}
                  {p.horizon_years}y horizon
                </span>
              </button>
            ))
          )}
        </aside>

        <section className="reports-detail">
          {active ? (
            <>
              <div className="page-section-head">
                <h2 style={{ marginTop: 0 }}>{active.name}</h2>
                <button
                  className="btn-link danger"
                  type="button"
                  onClick={() => void remove(active.id)}
                >
                  Delete
                </button>
              </div>

              {series && series.series.length > 0 && (
                <>
                  <div className="muted" style={{ marginBottom: 8 }}>
                    Ending balance at year {series.series.length - 1}:
                    {' '}
                    <strong>{formatCents(series.series.at(-1)!.nominal_cents)}</strong>
                    {' '}nominal
                    {active.annual_inflation_pct > 0 && (
                      <>
                        {' · '}
                        <strong>{formatCents(series.series.at(-1)!.real_cents)}</strong>
                        {' '}in today&apos;s dollars
                      </>
                    )}
                  </div>
                  <div className="card" style={{ padding: 12 }}>
                    <div style={{ width: '100%', height: 320 }}>
                      <ResponsiveContainer>
                        <LineChart data={series.series}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                          <XAxis dataKey="year" tick={{ fontSize: 12 }} />
                          <YAxis
                            tick={{ fontSize: 12 }}
                            width={70}
                            tickFormatter={(v: number) =>
                              `$${(v / 100 / 1000).toFixed(0)}k`
                            }
                          />
                          <Tooltip
                            formatter={(value) =>
                              formatCents(typeof value === 'number' ? value : Number(value))
                            }
                            labelFormatter={(label) => `Year ${String(label)}`}
                            contentStyle={{ fontSize: '0.85em' }}
                          />
                          <Line
                            type="monotone"
                            dataKey="nominal_cents"
                            name="Nominal"
                            stroke="#6366f1"
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                          />
                          {active.annual_inflation_pct > 0 && (
                            <Line
                              type="monotone"
                              dataKey="real_cents"
                              name="In today's dollars"
                              stroke="#10b981"
                              strokeWidth={2}
                              dot={false}
                              isAnimationActive={false}
                            />
                          )}
                          {series.target_amount_cents && (
                            <ReferenceLine
                              y={series.target_amount_cents}
                              stroke="#ef4444"
                              strokeDasharray="4 4"
                              label={{
                                value: `Target ${formatCents(series.target_amount_cents)}`,
                                position: 'insideTopRight',
                                fontSize: 11,
                                fill: '#ef4444',
                              }}
                            />
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </>
              )}

              <ProjectionDetailForm
                projection={active}
                onSaved={() => void load()}
              />
            </>
          ) : (
            <p className="empty">
              {projections.length === 0
                ? 'Create your first projection to see the chart.'
                : 'Pick a projection on the left.'}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function dollarsToCents(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function ProjectionForm({
  onSaved,
}: {
  onSaved: (p: RetirementProjection) => void;
}) {
  const [name, setName] = useState('Retirement');
  const [start, setStart] = useState('100000');
  const [monthly, setMonthly] = useState('1500');
  const [ret, setRet] = useState('7');
  const [inflation, setInflation] = useState('2.5');
  const [horizon, setHorizon] = useState(30);
  const [targetAmount, setTargetAmount] = useState('');
  const [targetYear, setTargetYear] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const projection = await api.createProjection({
        name: name.trim() || 'Retirement',
        startingBalanceCents: dollarsToCents(start),
        monthlyContributionCents: dollarsToCents(monthly),
        annualReturnPct: Number(ret) || 0,
        annualInflationPct: Number(inflation) || 0,
        horizonYears: horizon,
        targetAmountCents: targetAmount ? dollarsToCents(targetAmount) : null,
        targetYear: targetYear ? Number(targetYear) : null,
      });
      onSaved(projection);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ padding: 16, marginBottom: 16 }} onSubmit={submit}>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Starting balance ($)</label>
          <input
            type="number"
            step="100"
            min="0"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Monthly contribution ($)</label>
          <input
            type="number"
            step="50"
            min="0"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Annual return (%)</label>
          <input
            type="number"
            step="0.1"
            value={ret}
            onChange={(e) => setRet(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Annual inflation (%)</label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={inflation}
            onChange={(e) => setInflation(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Horizon (years)</label>
          <input
            type="number"
            min="1"
            max="100"
            value={horizon}
            onChange={(e) => setHorizon(Math.max(1, Math.min(100, Number(e.target.value) || 30)))}
          />
        </div>
        <div className="field">
          <label>Target amount ($, optional)</label>
          <input
            type="number"
            step="1000"
            min="0"
            value={targetAmount}
            onChange={(e) => setTargetAmount(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Target year (optional)</label>
          <input
            type="number"
            min="1900"
            max="2200"
            value={targetYear}
            onChange={(e) => setTargetYear(e.target.value)}
          />
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Create projection'}
        </button>
      </div>
    </form>
  );
}

function ProjectionDetailForm({
  projection,
  onSaved,
}: {
  projection: RetirementProjection;
  onSaved: () => void;
}) {
  const [monthly, setMonthly] = useState(String(projection.monthly_contribution_cents / 100));
  const [ret, setRet] = useState(String(projection.annual_return_pct));
  const [inflation, setInflation] = useState(String(projection.annual_inflation_pct));
  const [horizon, setHorizon] = useState(projection.horizon_years);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMonthly(String(projection.monthly_contribution_cents / 100));
    setRet(String(projection.annual_return_pct));
    setInflation(String(projection.annual_inflation_pct));
    setHorizon(projection.horizon_years);
  }, [projection.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateProjection(projection.id, {
        monthlyContributionCents: dollarsToCents(monthly),
        annualReturnPct: Number(ret) || 0,
        annualInflationPct: Number(inflation) || 0,
        horizonYears: horizon,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ padding: 16, marginTop: 16 }} onSubmit={submit}>
      <div className="page-section-head" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Tune</h2>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label>Monthly contribution ($)</label>
          <input type="number" step="50" min="0" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </div>
        <div className="field">
          <label>Annual return (%)</label>
          <input type="number" step="0.1" value={ret} onChange={(e) => setRet(e.target.value)} />
        </div>
        <div className="field">
          <label>Annual inflation (%)</label>
          <input type="number" step="0.1" min="0" value={inflation} onChange={(e) => setInflation(e.target.value)} />
        </div>
        <div className="field">
          <label>Horizon (years)</label>
          <input
            type="number"
            min="1"
            max="100"
            value={horizon}
            onChange={(e) => setHorizon(Math.max(1, Math.min(100, Number(e.target.value) || 30)))}
          />
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
