import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type CashFlowResponse } from '../api';
import { formatCents } from '../format';

/**
 * 0.21.5 — Scenario cash-flow forecasting.
 *
 * Lays "what if I earn 10% more" / "what if expenses drop 15%" /
 * "what if I get a $5,000 bonus on July 1" on top of the existing
 * /api/cash-flow projection. The scenario series is rendered
 * alongside the baseline so the delta is visible at a glance.
 */

interface OneTimeRow {
  date: string;
  dollars: string;
  kind: 'income' | 'expense';
}

export function ScenarioPage() {
  const [days, setDays] = useState(180);
  const [incomePct, setIncomePct] = useState(100);
  const [expensePct, setExpensePct] = useState(100);
  const [oneTime, setOneTime] = useState<OneTimeRow[]>([]);
  const [data, setData] = useState<CashFlowResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const oneTimeCents = oneTime
        .filter((r) => r.date && r.dollars.trim())
        .map((r) => {
          const n = Number(r.dollars);
          if (!Number.isFinite(n)) return null;
          return {
            date: r.date,
            amount_cents:
              Math.round(Math.abs(n) * 100) * (r.kind === 'expense' ? -1 : 1),
          };
        })
        .filter((x): x is { date: string; amount_cents: number } => x !== null);

      const r = await api.cashFlow({
        days,
        scenario: {
          incomePct,
          expensePct,
          oneTime: oneTimeCents,
        },
      });
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const chartData = useMemo(() => {
    if (!data) return [];
    const baseByDate = new Map(
      data.series.map((p) => [p.date, p.projected_cents / 100]),
    );
    const scenarioByDate = new Map(
      (data.scenario?.series ?? []).map((p) => [p.date, p.projected_cents / 100]),
    );
    return data.series.map((p) => ({
      date: p.date,
      baseline: baseByDate.get(p.date),
      scenario: scenarioByDate.get(p.date),
    }));
  }, [data]);

  const baselineDelta = data
    ? data.ending_cents - data.starting_cents
    : 0;
  const scenarioDelta = data?.scenario
    ? data.scenario.ending_cents - data.starting_cents
    : null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>What-if scenarios</h1>
          <div className="subtitle">
            Lay best-case / worst-case adjustments on top of your
            forecasted cash flow. Sliders nudge recurring income and
            bills proportionally; one-time events let you drop in a
            bonus, tax bill, or surprise expense.
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Controls</h2>
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field">
            <label>Horizon</label>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>6 months</option>
              <option value={365}>1 year</option>
            </select>
          </div>
          <div className="field">
            <label>
              Income: <strong>{incomePct}%</strong> of baseline
            </label>
            <input
              type="range"
              min={50}
              max={200}
              step={5}
              value={incomePct}
              onChange={(e) => setIncomePct(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>
              Expenses: <strong>{expensePct}%</strong> of baseline
            </label>
            <input
              type="range"
              min={50}
              max={200}
              step={5}
              value={expensePct}
              onChange={(e) => setExpensePct(Number(e.target.value))}
            />
          </div>
        </div>

        <h3 style={{ marginTop: 16 }}>One-time events</h3>
        {oneTime.length === 0 && (
          <p className="muted small">
            Add a bonus, tax payment, or surprise expense.
          </p>
        )}
        {oneTime.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <input
              type="date"
              value={r.date}
              onChange={(e) => {
                const next = [...oneTime];
                next[i] = { ...r, date: e.target.value };
                setOneTime(next);
              }}
            />
            <select
              value={r.kind}
              onChange={(e) => {
                const next = [...oneTime];
                next[i] = { ...r, kind: e.target.value as 'income' | 'expense' };
                setOneTime(next);
              }}
            >
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
            <input
              type="number"
              step="0.01"
              min="0"
              style={{ width: 140 }}
              placeholder="0.00"
              value={r.dollars}
              onChange={(e) => {
                const next = [...oneTime];
                next[i] = { ...r, dollars: e.target.value };
                setOneTime(next);
              }}
            />
            <button
              type="button"
              className="btn-link"
              onClick={() => setOneTime(oneTime.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn secondary"
            onClick={() =>
              setOneTime([
                ...oneTime,
                {
                  date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
                  dollars: '',
                  kind: 'income',
                },
              ])
            }
          >
            + Add one-time event
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void reload()}
            disabled={loading}
          >
            {loading ? 'Recomputing…' : 'Run scenario'}
          </button>
        </div>
      </div>

      {data && (
        <>
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <Metric
              label="Starting cash"
              value={formatCents(data.starting_cents)}
            />
            <Metric
              label="Baseline ending"
              value={formatCents(data.ending_cents)}
              tone={baselineDelta >= 0 ? 'pos' : 'neg'}
            />
            <Metric
              label="Scenario ending"
              value={
                data.scenario
                  ? formatCents(data.scenario.ending_cents)
                  : '—'
              }
              tone={
                scenarioDelta == null
                  ? undefined
                  : scenarioDelta >= 0
                    ? 'pos'
                    : 'neg'
              }
            />
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Projection</h2>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="date" minTickGap={32} />
                <YAxis
                  tickFormatter={(v) =>
                    `$${Math.round(v / 1000)}K`
                  }
                />
                <Tooltip
                  formatter={(v: unknown) =>
                    typeof v === 'number' ? formatCents(v * 100) : ''
                  }
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="baseline"
                  stroke="#9ca3af"
                  strokeWidth={2}
                  dot={false}
                  name="Baseline"
                />
                <Line
                  type="monotone"
                  dataKey="scenario"
                  stroke="#4f46e5"
                  strokeWidth={2.5}
                  dot={false}
                  name="Scenario"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'pos' | 'neg';
}) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 13 }}>{label}</div>
      <div
        style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}
        className={tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : ''}
      >
        {value}
      </div>
    </div>
  );
}
