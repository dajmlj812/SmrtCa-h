import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type BudgetPeriodSummary,
  type BudgetPeriodType,
  type BudgetVsActualRow,
  type Category,
} from '../api';
import { formatCents, formatDate } from '../format';
import { BudgetWizard } from '../components/BudgetWizard';

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

export function BudgetsPage() {
  const [month, setMonth] = useState<string>(() => firstOfMonth(new Date()));
  const [rows, setRows] = useState<BudgetVsActualRow[]>([]);
  const [totals, setTotals] = useState({ budgeted_cents: 0, actual_cents: 0 });
  const [period, setPeriod] = useState<BudgetPeriodSummary | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [wizardSummary, setWizardSummary] = useState<string | null>(null);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    try {
      // Pass the 15th of the month so the monthly period covers it cleanly.
      const asOf = m.replace(/-01$/, '-15');
      // 0.17.7 — fetch the period cash-flow summary alongside the
      // budget-vs-actual table. The summary renders above; the
      // table renders below (kept for actuals review).
      const [actuals, cats, periodSummary] = await Promise.all([
        api.budgetActuals(asOf),
        api.listCategories(),
        api.budgetPeriod(asOf),
      ]);
      setRows(actuals.rows);
      setTotals(actuals.totals);
      setCategories(cats);
      setPeriod(periodSummary);
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
          <h1>Budgets</h1>
          <div className="subtitle">
            Set a per-category budget plus one flex pool for everything else.
          </div>
        </div>
        <div className="toolbar inline">
          <button
            className="btn"
            onClick={() => setShowWizard(true)}
            title="Generate multiple future periods at once with bills + groceries + fuel + tolls pre-filled"
          >
            ✨ AutoMagic setup
          </button>
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

      {wizardSummary && <div className="banner success">{wizardSummary}</div>}

      {showWizard && (
        <BudgetWizard
          onClose={() => setShowWizard(false)}
          onCommitted={(r) => {
            setShowWizard(false);
            setWizardSummary(
              `Created ${r.created} budget row${r.created === 1 ? '' : 's'}` +
                (r.skipped > 0 ? `, skipped ${r.skipped} duplicate(s).` : '.'),
            );
            void load(month);
          }}
        />
      )}

      {error && <div className="banner error">{error}</div>}

      {/* 0.17.7 — period cash-flow overview. Income with dates,
        * bills line-per-bill, modifiable budgets, net. Renders
        * above the budget-vs-actual table (which is kept below
        * for spot-checking actuals against budgets).
        * 0.17.9 — always render if anything could be shown
        * (income from recurring_income, bills from bills table,
        * or editable from committed budget rows). The empty
        * state for set-aside shows a CTA pointing at AutoMagic.
        */}
      {period && (
        <PeriodOverview
          summary={period}
          onRunWizard={() => setShowWizard(true)}
        />
      )}

      {!loading && rows.length === 0 && (
        <div className="card empty-card">
          <p className="muted">
            No budgets set for {formatMonth(month)} yet. Use the form below to
            add one, or copy from the previous month.
          </p>
          <button className="btn secondary" type="button" onClick={copyPrev}>
            Copy from {formatMonth(prevMonth(month))}
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

  // Keep periodStart roughly in sync with the selected month, except when
  // the user is on weekly/biweekly (those typically want a specific day).
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
          <select
            id="budget-cat"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">— Pick one —</option>
            {!hasFlex && (
              <option value="__flex">Flex pool (everything else)</option>
            )}
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
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

/**
 * 0.17.7 — period cash-flow overview. The "what's expected to
 * happen this week/month" view the user actually wants: income
 * with dates, bills line-per-bill with vendor + amount + due
 * date, modifiable budgets with a "manually move to savings"
 * flag on Savings, and a leftover/overextended net at the
 * bottom.
 */
function PeriodOverview({
  summary,
  onRunWizard,
}: {
  summary: BudgetPeriodSummary;
  onRunWizard: () => void;
}) {
  const { period, income, bills, editable, totals } = summary;
  const periodLabel = PERIOD_LABELS[period.type];
  const overextended = totals.net_cents < 0;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="page-section-head">
        <h2 style={{ margin: 0 }}>Period overview</h2>
        <span className="muted small">
          {periodLabel} · {formatDate(period.start)} → {formatDate(period.end)}
        </span>
      </div>

      {/* Income */}
      <h3 style={{ marginTop: 16, marginBottom: 8 }}>
        Income — <strong className="pos">{formatCents(totals.income_cents)}</strong>
      </h3>
      {income.length === 0 ? (
        <p className="muted small">No income events in this period.</p>
      ) : (
        <table className="txn-table">
          <thead>
            <tr>
              <th>Source</th>
              <th className="nowrap">Expected</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {income.map((i) => (
              <tr key={i.id + i.date}>
                <td>{i.name}</td>
                <td className="nowrap">{formatDate(i.date)}</td>
                <td className="num pos">+{formatCents(i.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Bills */}
      <h3 style={{ marginTop: 16, marginBottom: 8 }}>
        Bills — <strong className="neg">{formatCents(totals.bills_cents)}</strong>
      </h3>
      {bills.length === 0 ? (
        <p className="muted small">No bills due in this period.</p>
      ) : (
        <table className="txn-table">
          <thead>
            <tr>
              <th>Vendor</th>
              <th className="nowrap">Due</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.budget_id}>
                <td>{b.name}</td>
                <td className="nowrap">{b.date ? formatDate(b.date) : <span className="muted">—</span>}</td>
                <td className="num neg">−{formatCents(b.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Modifiable / editable categories */}
      <h3 style={{ marginTop: 16, marginBottom: 8 }}>
        Set aside — <strong className="neg">{formatCents(totals.editable_cents)}</strong>
      </h3>
      {editable.length === 0 ? (
        <div className="card" style={{ background: 'var(--surface-3)', padding: 12 }}>
          <p style={{ margin: 0 }}>
            <strong>No category allowances configured for this period.</strong>
          </p>
          <p className="muted small" style={{ marginTop: 4 }}>
            Run AutoMagic Setup to suggest amounts for groceries, fuel, tolls, savings, etc. based on your history + bills + income.
          </p>
          <button
            className="btn"
            type="button"
            onClick={onRunWizard}
            style={{ marginTop: 8 }}
          >
            ✨ Run AutoMagic Setup
          </button>
        </div>
      ) : (
        <table className="txn-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Action</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {editable.map((e) => (
              <tr key={e.budget_id}>
                <td>{e.category_name}</td>
                <td className="muted small">
                  {e.requires_manual_action
                    ? 'Manually transfer to savings'
                    : 'Spending allowance'}
                </td>
                <td className="num neg">−{formatCents(e.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Net */}
      <div
        style={{
          marginTop: 20,
          paddingTop: 12,
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontSize: '1.05em',
        }}
      >
        <span>
          <strong>{overextended ? 'Overextended by' : 'Leftover'}</strong>
          <div className="muted small">
            Income − bills − set-aside ={' '}
            {formatCents(totals.income_cents)} − {formatCents(totals.bills_cents)} −{' '}
            {formatCents(totals.editable_cents)}
          </div>
        </span>
        <strong className={overextended ? 'neg' : 'pos'} style={{ fontSize: '1.3em' }}>
          {overextended ? '−' : '+'}
          {formatCents(Math.abs(totals.net_cents))}
        </strong>
      </div>
      {overextended && (
        <p className="muted small" style={{ marginTop: 8 }}>
          You'll need to cover this gap — either by reducing one of the modifiable
          allowances above or by accepting that some bills will roll forward.
        </p>
      )}
    </div>
  );
}
