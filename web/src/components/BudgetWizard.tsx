import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type WizardPreview } from '../api';
import { formatCents, formatDate } from '../format';

type PeriodType = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
const PERIOD_LABELS: Record<PeriodType, string> = {
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  semimonthly: 'Semi-monthly',
  monthly: 'Monthly',
};

interface Props {
  onClose: () => void;
  /** Called after commit so the parent can refresh the budget list. */
  onCommitted: (result: { created: number; skipped: number }) => void;
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sum-with-bills helpers for the per-period totals row. */
function sumBills(p: WizardPreview['periods'][number]): number {
  return p.bills.reduce((acc, b) => acc + b.amount_cents, 0);
}
function sumIncome(p: WizardPreview['periods'][number]): number {
  return p.income.reduce((acc, i) => acc + i.amount_cents, 0);
}

export function BudgetWizard({ onClose, onCommitted }: Props) {
  const [periodType, setPeriodType] = useState<PeriodType>('weekly');
  const [anchor, setAnchor] = useState(todayYmd());
  const [count, setCount] = useState(5);
  const [preview, setPreview] = useState<WizardPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  /** Inline overrides for the three editable categories, keyed by period index. */
  const [overrides, setOverrides] = useState<{
    groceries: Record<number, number>;
    fuel: Record<number, number>;
    tolls: Record<number, number>;
  }>({ groceries: {}, fuel: {}, tolls: {} });

  const loadPreview = useCallback(async () => {
    setPreviewing(true);
    setError(null);
    try {
      const p = await api.budgetWizardPreview({
        periodType,
        anchor,
        count,
        groceriesOverrideCents: overrides.groceries,
        fuelOverrideCents: overrides.fuel,
        tollsOverrideCents: overrides.tolls,
      });
      setPreview(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }, [periodType, anchor, count, overrides]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  function override(field: 'groceries' | 'fuel' | 'tolls', idx: number, value: string) {
    const cents = Math.round(Number(value) * 100);
    setOverrides((prev) => {
      const next = { ...prev, [field]: { ...prev[field] } };
      if (!Number.isFinite(cents) || cents < 0) {
        delete next[field][idx];
      } else {
        next[field][idx] = cents;
      }
      return next;
    });
  }

  async function commit() {
    setCommitting(true);
    setError(null);
    try {
      const r = await api.budgetWizardCommit({
        periodType,
        anchor,
        count,
        groceriesOverrideCents: overrides.groceries,
        fuelOverrideCents: overrides.fuel,
        tollsOverrideCents: overrides.tolls,
      });
      onCommitted({ created: r.created, skipped: r.skipped });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Commit failed');
    } finally {
      setCommitting(false);
    }
  }

  function inputsHeader(e: FormEvent) {
    e.preventDefault();
    void loadPreview();
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="modal modal-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2>AutoMagic budget setup</h2>
            <div className="modal-subtitle">
              Income + bills come from your existing data. Groceries / Fuel /
              Tolls are pre-filled and editable per period.
            </div>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>

        {error && <div className="banner error">{error}</div>}

        <form className="wizard-controls" onSubmit={inputsHeader}>
          <div className="field">
            <label htmlFor="wiz-period">Period</label>
            <select
              id="wiz-period"
              value={periodType}
              onChange={(e) => setPeriodType(e.target.value as PeriodType)}
            >
              {(['weekly', 'biweekly', 'semimonthly', 'monthly'] as const).map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="wiz-anchor">Start date</label>
            <input
              id="wiz-anchor"
              type="date"
              value={anchor}
              onChange={(e) => setAnchor(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="wiz-count">How many periods</label>
            <input
              id="wiz-count"
              type="number"
              min="1"
              max="24"
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(24, Number(e.target.value) || 5)))}
            />
          </div>
          <button className="btn secondary" type="submit" disabled={previewing}>
            {previewing ? 'Previewing…' : 'Refresh preview'}
          </button>
        </form>

        {preview && (
          <>
            <div className="wizard-defaults muted">
              Source defaults · Groceries median {formatCents(preview.groceriesWeeklyMedianCents)}/wk · Fuel {formatCents(preview.fuelWeeklyCents)}/wk · Tolls {formatCents(preview.tollsWeeklyCents)}/wk
            </div>
            <div className="wizard-grid">
              {preview.periods.map((p) => (
                <div key={p.index} className="wizard-period">
                  <div className="wizard-period-head">
                    <strong>Period {p.index + 1}</strong>
                    <span className="muted">
                      {formatDate(p.start)} → {formatDate(p.end)} ({p.days} days)
                    </span>
                  </div>

                  <table className="wizard-table">
                    <tbody>
                      <tr>
                        <td className="muted">Income</td>
                        <td className="num pos">{formatCents(sumIncome(p))}</td>
                        <td className="muted">
                          {p.income.length === 0
                            ? 'none'
                            : p.income.map((i) => `${i.name} · ${formatCents(i.amount_cents)}`).join(' · ')}
                        </td>
                      </tr>
                      <tr>
                        <td className="muted">Bills</td>
                        <td className="num neg">{formatCents(-sumBills(p))}</td>
                        <td className="muted">
                          {p.bills.length === 0
                            ? 'none'
                            : p.bills.map((b) => `${b.name} · ${formatCents(b.amount_cents)}`).join(' · ')}
                        </td>
                      </tr>
                      <EditableRow
                        label="Groceries"
                        cents={p.groceriesCents}
                        onChange={(v) => override('groceries', p.index, v)}
                      />
                      <EditableRow
                        label="Fuel"
                        cents={p.fuelCents}
                        onChange={(v) => override('fuel', p.index, v)}
                      />
                      <EditableRow
                        label="Tolls"
                        cents={p.tollsCents}
                        onChange={(v) => override('tolls', p.index, v)}
                      />
                      <tr className="wizard-flex">
                        <td className="muted">Flex (remaining)</td>
                        <td className={`num ${p.flexCents >= 0 ? 'pos' : 'neg'}`}>
                          {formatCents(p.flexCents)}
                        </td>
                        <td className="muted">income − bills − the three</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="wizard-actions">
          <button
            className="btn"
            type="button"
            disabled={!preview || committing}
            onClick={() => void commit()}
          >
            {committing
              ? 'Committing…'
              : preview
                ? `Commit ${count} ${PERIOD_LABELS[periodType].toLowerCase()} budgets`
                : 'Loading…'}
          </button>
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
            Existing rows are never overwritten — duplicates are skipped.
          </span>
        </div>
      </div>
    </div>
  );
}

function EditableRow({
  label,
  cents,
  onChange,
}: {
  label: string;
  cents: number;
  onChange: (value: string) => void;
}) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">
        <input
          type="number"
          step="0.01"
          min="0"
          value={(cents / 100).toFixed(2)}
          onChange={(e) => onChange(e.target.value)}
          className="wizard-amount"
        />
      </td>
      <td className="muted">editable per period</td>
    </tr>
  );
}
