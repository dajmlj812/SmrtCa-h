import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
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
      const recurring = r.recurring_category_count ?? 0;
      const msg =
        r.created > 0
          ? `Seeded ${r.created} budget row(s) — ${r.bill_count} from bills` +
            (recurring > 0
              ? `, ${recurring} from recurring spend categories (3-month average)`
              : '') +
            `. Monthly total ${(r.total_monthly_cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}.`
          : 'Every bill and recurring category already had a budget — nothing to add.';
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

  /**
   * 0.21.x — bulk remove every budget row in a category for the
   * current month. Useful when the user no longer wants to track
   * a category at all (or wants to start fresh and re-seed).
   */
  async function onDeleteGroup(group: {
    categoryName: string;
    rows: BudgetVsActualRow[];
  }) {
    if (
      !confirm(
        `Remove all ${group.rows.length} budget row(s) under "${group.categoryName}" for ${formatMonth(month)}?\n\n` +
          'This deletes the budget entries only; transactions and bills are not affected.',
      )
    )
      return;
    try {
      for (const r of group.rows) {
        await api.deleteBudget(r.id);
      }
      await load(month);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function onAmountChange(id: string, amountCents: number) {
    try {
      await api.updateBudgetAmount(id, amountCents);
      await load(month);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  /**
   * 0.21.x — change the *category-level* total. The change is
   * applied to the category-only row (no bill_id): patch its
   * amount, create it if it doesn't exist, or delete it if the
   * new total would push it ≤ 0.
   */
  async function onSetCategoryTotal(
    group: {
      categoryId: string | null;
      categoryName: string;
      rows: BudgetVsActualRow[];
    },
    newTotalCents: number,
  ) {
    if (!group.categoryId) {
      setError(
        'Editing the flex-pool total isn\'t supported here — edit the row directly.',
      );
      return;
    }
    const currentTotal = group.rows.reduce((s, r) => s + r.budgeted_cents, 0);
    const delta = newTotalCents - currentTotal;
    if (delta === 0) return;
    const categoryOnlyRow = group.rows.find((r) => r.bill_id === null);
    try {
      if (categoryOnlyRow) {
        const next = categoryOnlyRow.budgeted_cents + delta;
        if (next <= 0) {
          await api.deleteBudget(categoryOnlyRow.id);
        } else {
          await api.updateBudgetAmount(categoryOnlyRow.id, next);
        }
      } else {
        if (delta <= 0) {
          setError(
            `Can't lower ${group.categoryName} below its bill total. Edit individual bills instead.`,
          );
          return;
        }
        await api.upsertBudget({
          periodStart: month,
          periodType: 'monthly',
          categoryId: group.categoryId,
          amountCents: delta,
        });
      }
      await load(month);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  const hasFlex = rows.some((r) => r.category_id === null);
  const budgetedIds = new Set(
    rows.map((r) => r.category_id).filter((id): id is string => id !== null),
  );

  // 0.21.x — group rows by category. Each category becomes one
  // collapsible card; bills nested as children show only when
  // expanded.
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      { categoryId: string | null; categoryName: string; rows: BudgetVsActualRow[] }
    >();
    for (const r of rows) {
      const key = r.category_id ?? '__flex';
      const existing = map.get(key);
      if (existing) {
        existing.rows.push(r);
      } else {
        map.set(key, {
          categoryId: r.category_id,
          categoryName: r.category_name ?? 'Flex pool (everything else)',
          rows: [r],
        });
      }
    }
    return [...map.values()].sort((a, b) =>
      a.categoryName.localeCompare(b.categoryName),
    );
  }, [rows]);

  const consumedPct =
    totals.budgeted_cents > 0
      ? Math.min(100, (totals.actual_cents / totals.budgeted_cents) * 100)
      : 0;
  const overspent = totals.actual_cents > totals.budgeted_cents;
  const todayStr = new Date().toISOString().slice(0, 10);
  const isFutureMonth = month > todayStr;

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
            aria-label="Previous month"
          >
            ←
          </button>
          <span className="month-label">{formatMonth(month)}</span>
          <button
            className="btn secondary"
            onClick={() => setMonth(nextMonthOf(month))}
            aria-label="Next month"
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
        <>
          {/* Headline summary card with the month's headline numbers
              + a thick progress ring along the right edge. */}
          <div className="card budget-hero">
            <div className="budget-hero-stats">
              <BudgetStat
                label="Budgeted"
                value={formatCents(totals.budgeted_cents)}
              />
              <BudgetStat
                label={isFutureMonth ? 'Spent (forecast)' : 'Spent'}
                value={formatCents(totals.actual_cents)}
                tone={overspent ? 'neg' : undefined}
              />
              <BudgetStat
                label={
                  totals.budgeted_cents - totals.actual_cents < 0
                    ? 'Over by'
                    : 'Remaining'
                }
                value={formatCents(
                  Math.abs(totals.budgeted_cents - totals.actual_cents),
                )}
                tone={overspent ? 'neg' : 'pos'}
              />
              <BudgetStat
                label="Consumed"
                value={`${consumedPct.toFixed(0)}%`}
                tone={overspent ? 'neg' : undefined}
              />
            </div>
            <div
              className={`budget-hero-bar ${overspent ? 'over' : ''}`}
              role="progressbar"
              aria-valuenow={consumedPct}
              aria-valuemin={0}
              aria-valuemax={100}
              title={`${consumedPct.toFixed(0)}% consumed`}
            >
              <div
                className="budget-hero-bar-fill"
                style={{ width: `${consumedPct}%` }}
              />
            </div>
            <div className="budget-hero-actions">
              <button
                className="btn secondary"
                type="button"
                onClick={seedFromBills}
                title="Add monthly budget rows for bills + recurring categories you haven't budgeted yet"
              >
                ✨ Seed missing rows
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={copyPrev}
                title={`Copy every monthly row from ${formatMonth(prevMonth(month))}`}
              >
                Copy from {formatMonth(prevMonth(month))}
              </button>
            </div>
          </div>

          {isFutureMonth && (
            <div className="banner info" style={{ marginTop: 12 }}>
              This is a <strong>future month</strong> — actuals show 0 across
              the board until transactions for this month start landing.
              The numbers above are a forecast based on your seeded rows.
            </div>
          )}

          {/* Category-grouped budget list. Collapsed by default;
              chevron expands to per-bill detail. Category total is
              editable directly (delta flows onto the category-only
              row or creates one). */}
          <div className="budget-groups">
            {grouped.map((g) => (
              <CategoryGroupCard
                key={g.categoryId ?? '__flex'}
                group={g}
                month={month}
                onAmountChange={onAmountChange}
                onDelete={onDelete}
                onDeleteGroup={onDeleteGroup}
                onSetCategoryTotal={onSetCategoryTotal}
              />
            ))}
          </div>
        </>
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
  onAmountChange,
}: {
  row: BudgetVsActualRow;
  onDelete: () => void;
  onAmountChange: (newCents: number) => Promise<void>;
}) {
  const pct =
    row.budgeted_cents === 0
      ? 0
      : Math.min(100, (row.actual_cents / row.budgeted_cents) * 100);
  const over = row.actual_cents > row.budgeted_cents;
  // 0.21.x — label preference: bill name first (each seeded bill is
  // its own line and the bill name is the meaningful identifier),
  // then category name, then the flex-pool fallback.
  const label =
    row.bill_name ?? row.category_name ?? 'Flex pool (everything else)';

  // 0.21.x — inline-editable budgeted amount. Click pencil → edit
  // dollars → enter or blur to save. Esc cancels.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  async function commit() {
    if (!editing) return;
    setSaving(true);
    const cents = Math.round(Number(draft) * 100);
    if (Number.isFinite(cents) && cents > 0 && cents !== row.budgeted_cents) {
      try {
        await onAmountChange(cents);
      } catch {
        /* parent surfaces the error */
      }
    }
    setSaving(false);
    setEditing(false);
  }

  return (
    <div className="budget-row">
      <div className="budget-row-head">
        <span className="budget-row-name">
          {label}
          <span className="pill period-pill">{PERIOD_LABELS[row.period_type]}</span>
          {row.bill_name && row.category_name && (
            <span className="muted small" style={{ marginLeft: 8 }}>
              {row.category_name}
            </span>
          )}
        </span>
        <span className="budget-row-num">
          <span className={over ? 'neg' : ''}>
            {formatCents(row.actual_cents)}
          </span>
          <span className="muted"> / </span>
          {editing ? (
            <input
              type="number"
              step="0.01"
              min="0.01"
              autoFocus
              disabled={saving}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit();
                if (e.key === 'Escape') setEditing(false);
              }}
              onBlur={() => void commit()}
              style={{ width: 90, textAlign: 'right' }}
            />
          ) : (
            <button
              type="button"
              className="budget-amount-edit"
              title="Click to edit the monthly budget for this row"
              onClick={() => {
                setDraft((row.budgeted_cents / 100).toFixed(2));
                setEditing(true);
              }}
            >
              {formatCents(row.budgeted_cents)}
              <span aria-hidden style={{ marginLeft: 4, opacity: 0.5 }}>✎</span>
            </button>
          )}
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

function CategoryGroupCard({
  group,
  month,
  onAmountChange,
  onDelete,
  onDeleteGroup,
  onSetCategoryTotal,
}: {
  group: {
    categoryId: string | null;
    categoryName: string;
    rows: BudgetVsActualRow[];
  };
  month: string;
  onAmountChange: (id: string, cents: number) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDeleteGroup: (group: {
    categoryName: string;
    rows: BudgetVsActualRow[];
  }) => Promise<void>;
  onSetCategoryTotal: (
    group: {
      categoryId: string | null;
      categoryName: string;
      rows: BudgetVsActualRow[];
    },
    newTotalCents: number,
  ) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const groupBudget = group.rows.reduce((s, r) => s + r.budgeted_cents, 0);
  const groupActual = group.rows.reduce((s, r) => s + r.actual_cents, 0);
  const over = groupActual > groupBudget;
  const pct =
    groupBudget === 0 ? 0 : Math.min(100, (groupActual / groupBudget) * 100);
  const childCount = group.rows.length;
  const hasChildren = childCount > 1 || group.rows.some((r) => r.bill_id);
  void month; // referenced for parent reload context

  async function commit() {
    if (!editing) return;
    setSaving(true);
    const cents = Math.round(Number(draft) * 100);
    if (Number.isFinite(cents) && cents >= 0 && cents !== groupBudget) {
      try {
        await onSetCategoryTotal(group, cents);
      } catch {
        /* parent surfaces error */
      }
    }
    setSaving(false);
    setEditing(false);
  }

  return (
    <div className={`budget-group ${expanded ? 'expanded' : ''}`}>
      <div className="budget-group-head">
        <button
          type="button"
          className="budget-group-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          disabled={!hasChildren}
          title={
            hasChildren
              ? `${expanded ? 'Hide' : 'Show'} ${childCount} item${childCount === 1 ? '' : 's'}`
              : ''
          }
        >
          <span className="chev" aria-hidden>
            {hasChildren ? (expanded ? '▼' : '▶') : ''}
          </span>
          <h3>{group.categoryName}</h3>
          {hasChildren && (
            <span className="muted small">
              {childCount} item{childCount === 1 ? '' : 's'}
            </span>
          )}
        </button>
        <div className="budget-group-total">
          <span className={over ? 'neg' : ''}>{formatCents(groupActual)}</span>
          <span className="muted"> / </span>
          {editing ? (
            <input
              type="number"
              step="0.01"
              min="0"
              autoFocus
              disabled={saving}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit();
                if (e.key === 'Escape') setEditing(false);
              }}
              onBlur={() => void commit()}
              style={{ width: 100, textAlign: 'right' }}
            />
          ) : (
            <button
              type="button"
              className="budget-amount-edit"
              title="Click to edit the category total. Change flows onto the category-only row (no bill)."
              onClick={() => {
                setDraft((groupBudget / 100).toFixed(2));
                setEditing(true);
              }}
            >
              {formatCents(groupBudget)}
              <span aria-hidden style={{ marginLeft: 4, opacity: 0.5 }}>✎</span>
            </button>
          )}
          <button
            type="button"
            className="budget-group-remove"
            title="Remove every budget row in this category for this month"
            aria-label={`Remove ${group.categoryName}`}
            onClick={() => void onDeleteGroup(group)}
          >
            ×
          </button>
        </div>
      </div>
      <div className="budget-group-progress">
        <div
          className={`budget-group-progress-fill ${over ? 'over' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {expanded && (
        <div className="budget-list" style={{ marginTop: 8 }}>
          {group.rows.map((r) => (
            <BudgetRow
              key={r.id}
              row={r}
              onDelete={() => void onDelete(r.id)}
              onAmountChange={(cents) => onAmountChange(r.id, cents)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BudgetStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'pos' | 'neg';
}) {
  return (
    <div className="budget-stat">
      <div className="muted small">{label}</div>
      <div
        className={`budget-stat-value ${tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}
