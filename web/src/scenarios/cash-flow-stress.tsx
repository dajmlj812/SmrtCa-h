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
import type { ScenarioDef } from './types';
import { CentsMetric } from './helpers';

/**
 * 0.24.0 — Cash-flow stress test. The original /scenarios behavior,
 * preserved verbatim and re-shaped as a registered scenario type.
 * This is the only scenario that talks to the server (it needs the
 * historical /api/cash-flow baseline); everything else in 0.24.x is
 * pure client-side math.
 */

interface OneTimeRow {
  date: string;
  dollars: string;
  kind: 'income' | 'expense';
}

interface Inputs {
  days: number;
  incomePct: number;
  expensePct: number;
  oneTime: OneTimeRow[];
}

const defaults: Inputs = {
  days: 180,
  incomePct: 100,
  expensePct: 100,
  oneTime: [],
};

function Form({
  inputs,
  onChange,
}: {
  inputs: Inputs;
  onChange: (next: Inputs) => void;
}) {
  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="field">
          <label>Horizon</label>
          <select
            value={inputs.days}
            onChange={(e) => onChange({ ...inputs, days: Number(e.target.value) })}
          >
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>6 months</option>
            <option value={365}>1 year</option>
          </select>
        </div>
        <div className="field">
          <label>
            Income: <strong>{inputs.incomePct}%</strong> of baseline
          </label>
          <input
            type="range"
            min={50}
            max={200}
            step={5}
            value={inputs.incomePct}
            onChange={(e) =>
              onChange({ ...inputs, incomePct: Number(e.target.value) })
            }
          />
        </div>
        <div className="field">
          <label>
            Expenses: <strong>{inputs.expensePct}%</strong> of baseline
          </label>
          <input
            type="range"
            min={50}
            max={200}
            step={5}
            value={inputs.expensePct}
            onChange={(e) =>
              onChange({ ...inputs, expensePct: Number(e.target.value) })
            }
          />
        </div>
      </div>

      <h3 style={{ marginTop: 16 }}>One-time events</h3>
      {inputs.oneTime.length === 0 && (
        <p className="muted small">Add a bonus, tax payment, or surprise expense.</p>
      )}
      {inputs.oneTime.map((r, i) => (
        <div
          key={i}
          style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}
        >
          <input
            type="date"
            value={r.date}
            onChange={(e) => {
              const next = [...inputs.oneTime];
              next[i] = { ...r, date: e.target.value };
              onChange({ ...inputs, oneTime: next });
            }}
          />
          <select
            value={r.kind}
            onChange={(e) => {
              const next = [...inputs.oneTime];
              next[i] = { ...r, kind: e.target.value as 'income' | 'expense' };
              onChange({ ...inputs, oneTime: next });
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
              const next = [...inputs.oneTime];
              next[i] = { ...r, dollars: e.target.value };
              onChange({ ...inputs, oneTime: next });
            }}
          />
          <button
            type="button"
            className="btn-link"
            onClick={() =>
              onChange({
                ...inputs,
                oneTime: inputs.oneTime.filter((_, j) => j !== i),
              })
            }
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn secondary"
        style={{ marginTop: 8 }}
        onClick={() =>
          onChange({
            ...inputs,
            oneTime: [
              ...inputs.oneTime,
              {
                date: new Date(Date.now() + 30 * 86_400_000)
                  .toISOString()
                  .slice(0, 10),
                dollars: '',
                kind: 'income',
              },
            ],
          })
        }
      >
        + Add one-time event
      </button>
    </>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const [data, setData] = useState<CashFlowResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const oneTimeCents = inputs.oneTime
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
    api
      .cashFlow({
        days: inputs.days,
        scenario: {
          incomePct: inputs.incomePct,
          expensePct: inputs.expensePct,
          oneTime: oneTimeCents,
        },
      })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Load failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inputs]);

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

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="empty">{loading ? 'Computing…' : ''}</p>;

  const baselineDelta = data.ending_cents - data.starting_cents;
  const scenarioDelta = data.scenario
    ? data.scenario.ending_cents - data.starting_cents
    : null;

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <CentsMetric label="Starting cash" cents={data.starting_cents} />
        <CentsMetric
          label="Baseline ending"
          cents={data.ending_cents}
          tone={baselineDelta >= 0 ? 'pos' : 'neg'}
        />
        <CentsMetric
          label="Scenario ending"
          cents={data.scenario?.ending_cents ?? 0}
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
            <YAxis tickFormatter={(v) => `$${Math.round(v / 1000)}K`} />
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
  );
}

const cashFlowStress: ScenarioDef<Inputs> = {
  id: 'cash-flow-stress',
  title: 'Cash-flow stress test',
  subtitle: 'Adjust income / expense % and one-time events on the cash-flow forecast.',
  category: 'cash-flow',
  icon: '📈',
  defaults,
  Form,
  Result,
};

export default cashFlowStress;
