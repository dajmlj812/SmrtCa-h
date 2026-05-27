import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type BudgetPeriodType,
  type BudgetVsActualRow,
  type Category,
} from '../api';
import { formatCents, formatDate } from '../format';
import { CategoryPicker } from '../components/CategoryPicker';

/**
 * 0.21.8 — Monthly Budget (one of two pages the previous /budgets
 * was split into).
 *
 * This page is the calendar-month, per-category view: pick a
 * month, see budgeted vs actual per category, add new budget
 * rows from the form below. The Paycheck-to-Paycheck plan view
 * lives at /paycheck-budget.
 */

const PERIOD_LABELS: Record<BudgetPeriodType, string> = {
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  semimonthly: 'Semi-monthly',
  monthly: 'Monthly',
  custom: 'Custom',
};

function firstOfMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return firstOfMonth(d);
}
function nextMonthOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 1));
  return firstOfMonth(d);
}
function formatMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('default', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function MonthlyBudgetPage() {
  const [month, setMonth] = useState<string>(() => firstOfMonth(new Date()));
  const [rows, setRows] = useState<BudgetVsActualRow[]>([]);
  const [totals, setTotals] = useState({ budgeted_cents: 0, actual_cents: 0 });
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    try {
      const asOf = m.replace(/-01$/, '-15');
      const [actuals, cats] = await Promise.all([
        api.budgetActuals(asOf),
        api.listCategories(),
      ]);
      setRows(actuals.rows);
      setTotals(actuals.totals);
      setCategories(cats);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load budgets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(month);
  }, [load, month]);

  async function copyPrev() {
    try {
      await api.copyBudgets(prevMonth(month), month);
      await load(month);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Copy failed');
    }
  }

  async function seedFromBills() {
    setError(null);
    const overwrite = rows.length > 0 && confirm(
      `Replace the ${rows.length} existing budget row(s) for ${formatMonth(month)} ` +
        'with a fresh seed from active bills?\n\n' +
        'Click OK to wipe and reseed, or Cancel to only add rows for categories ' +
        "that don't have a budget yet (existing rows untouched).",
    );
    try {
      const r = await api.seedBudgetFromBills(month, overwrite);
      if (r.bill_count === 0) {
        alert('No active bills to seed from. Add bills on /bills first.');
        return;
      }
      const msg =
        r.created > 0
          ? `Seeded ${r.created} budget row(s) from ${r.bill_count} bill(s). ` +
            `Monthly total ${(r.total_monthly_cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}.`
          : 'Every bill category already had a budget — nothing to add.';
      alert(msg);
      await load(month);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Seed failed');
    }
  }

  async function onUpsert(input: {
    categoryId: string | null;
    amountCents: number;
    periodType: BudgetPeriodType;
    periodStart: string;
    periodEnd?: string;
  }) {
    try {
      await api.upsertBudget({
        periodStart: input.periodStart,
        periodType: input.periodType,
        ...(input.periodEnd ? { periodEnd: input.periodEnd } : {}),
        categoryId: input.categoryId,
        amountCents: input.amountCents,
      });
      await load(month);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function onDelete(id: string) {
    try {
      await api.deleteBudget(id);
      await load(month);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const hasFlex = rows.some((r) => r.category_id === null);
  const budgetedIds = new Set(
    rows.map((r) => r.category_id).filter((id): id is string => id !== null),
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Monthly Budget</h1>
          <div className="subtitle">
            Calendar-month actuals against per-category budgets.
            For paycheck-cycle plans with bills and set-asides, see{' '}
            <strong>Paycheck budget</strong> in the sidebar.
          </div>
        </div>
        <div className="toolbar inline">
          <button
            className="btn secondary"
            onClick={() => setMonth(prevMonth(month))}
          >
            ←
          </button>
          <span className="month-label">{formatMonth(month)}</span>
          <button
            className="btn secondary"
            onClick={() => setMonth(nextMonthOf(month))}
          >
            →
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {!loading && rows.length === 0 && (
        <div className="card empty-card">
          <p className="muted">
            No budgets set for {formatMonth(month)} yet. Quick-start options:
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" type="button" onClick={seedFromBills}>
              ✨ Seed from recurring bills
            </button>
            <button className="btn secondary" type="button" onClick={copyPrev}>
              Copy from {formatMonth(prevMonth(month))}
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            Or use the form below to add a single row manually.
          </p>
        </div>
      )}
      {!loading && rows.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            margin: '8px 0',
          }}
        >
          <button
            className="btn secondary"
            type="button"
            onClick={seedFromBills}
            title="Add monthly budget rows for any category that has active bills but no budget yet"
          >
            ✨ Seed missing rows from bills
          </button>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="card">
          <div className="budget-totals">
            <span>
              <span className="muted">Total budgeted </span>
              <strong>{formatCents(totals.budgeted_cents)}</strong>
            </span>
            <span>
              <span className="muted">Total spent </span>
              <strong
                className={
                  totals.actual_cents > totals.budgeted_cents ? 'neg' : ''
                }
              >
                {formatCents(totals.actual_cents)}
              </strong>
            </span>
            <span>
              <span className="muted">Remaining </span>
              <strong>
                {formatCents(totals.budgeted_cents - totals.actual_cents)}
              </strong>
            </span>
          </div>
          <div className="budget-list">
            {rows.map((r) => (
              <BudgetRow key={r.id} row={r} onDelete={() => void onDelete(r.id)} />
            ))}
          </div>
        </div>
      )}

      <BudgetAddForm
        month={month}
        categories={categories}
        hasFlex={hasFlex}
        budgetedIds={budgetedIds}
        onAdd={onUpsert}
      />
    </div>
  );
}

function BudgetRow({
  row,
  onDelete,
}: {
  row: BudgetVsActualRow;
  onDelete: () => void;
}) {
  const pct =
    row.budgeted_cents === 0
      ? 0
      : Math.min(100, (row.actual_cents / row.budgeted_cents) * 100);
  const over = row.actual_cents > row.budgeted_cents;
  const label =
    row.category_id === null ? 'Flex pool (everything else)' : row.category_name;
  return (
    <div className="budget-row">
      <div className="budget-row-head">
        <span className="budget-row-name">
          {label}
          <span className="pill period-pill">{PERIOD_LABELS[row.period_type]}</span>
        </span>
        <span className="budget-row-num">
          <span className={over ? 'neg' : ''}>
            {formatCents(row.actual_cents)}
          </span>
          <span className="muted"> / {formatCents(row.budgeted_cents)}</span>
        </span>
        <button className="btn-link danger" type="button" onClick={onDelete}>
          Remove
        </button>
      </div>
      <div className="muted budget-row-period">
        {formatDate(row.period_start)} → {formatDate(row.period_end)}
      </div>
      <div className="progress-track">
        <div
          className={`progress-fill ${over ? 'over' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function BudgetAddForm({
  month,
  categories,
  hasFlex,
  budgetedIds,
  onAdd,
}: {
  month: string;
  categories: Category[];
  hasFlex: boolean;
  budgetedIds: Set<string>;
  onAdd: (input: {
    categoryId: string | null;
    amountCents: number;
    periodType: BudgetPeriodType;
    periodStart: string;
    periodEnd?: string;
  }) => Promise<void>;
}) {
  const [categoryId, setCategoryId] = useState<string>('');
  const [dollars, setDollars] = useState('');
  const [periodType, setPeriodType] = useState<BudgetPeriodType>('monthly');
  const [periodStart, setPeriodStart] = useState(month);
  const [periodEnd, setPeriodEnd] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const available = categories.filter(
    (c) => c.parent_id !== null && !budgetedIds.has(c.id),
  );

  function handlePeriodTypeChange(value: BudgetPeriodType) {
    setPeriodType(value);
    if (value === 'monthly') setPeriodStart(month);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(dollars) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return;
    if (periodType === 'custom' && (!periodEnd || periodEnd <= periodStart)) {
      return;
    }
    setSubmitting(true);
    try {
      await onAdd({
        categoryId: categoryId === '__flex' ? null : categoryId || null,
        amountCents: cents,
        periodType,
        periodStart,
        ...(periodType === 'custom' ? { periodEnd } : {}),
      });
      setCategoryId('');
      setDollars('');
      setPeriodType('monthly');
      setPeriodStart(month);
      setPeriodEnd('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card budget-add-form" onSubmit={submit}>
      <div className="section-title" style={{ marginTop: 0 }}>
        Add budget
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="budget-cat">Category</label>
          <CategoryPicker
            categories={available}
            value={categoryId === '' || categoryId === '__flex' ? null : categoryId}
            allowFlex={!hasFlex}
            onChange={(id) =>
              setCategoryId(id === null ? (hasFlex ? '' : '__flex') : id)
            }
          />
        </div>
        <div className="field">
          <label htmlFor="budget-amt">Amount ($)</label>
          <input
            id="budget-amt"
            type="number"
            step="0.01"
            min="0.01"
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="budget-period">Period</label>
          <select
            id="budget-period"
            value={periodType}
            onChange={(e) => handlePeriodTypeChange(e.target.value as BudgetPeriodType)}
          >
            <option value="monthly">Monthly</option>
            <option value="semimonthly">Semi-monthly (every 15 days)</option>
            <option value="biweekly">Bi-weekly (every 14 days)</option>
            <option value="weekly">Weekly</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="budget-start">
            {periodType === 'monthly' ? 'Period (month)' : 'Start date'}
          </label>
          <input
            id="budget-start"
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
          />
        </div>
        {periodType === 'custom' && (
          <div className="field">
            <label htmlFor="budget-end">End date</label>
            <input
              id="budget-end"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              required
            />
          </div>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <button
          className="btn"
          type="submit"
          disabled={submitting || categoryId === '' || dollars === ''}
        >
          {submitting ? 'Saving…' : 'Add budget'}
        </button>
      </div>
    </form>
  );
}
