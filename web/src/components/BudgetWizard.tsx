import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Account, type WizardPreview } from '../api';
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
  onCommitted: (result: { planId: string; created: number; skipped: number }) => void;
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
  // 0.17.16 — every wizard run produces a NAMED plan. Required;
  // the commit button stays disabled until the user types one.
  const [planName, setPlanName] = useState('');
  const [periodType, setPeriodType] = useState<PeriodType>('weekly');
  const [anchor, setAnchor] = useState(todayYmd());
  const [count, setCount] = useState(5);
  const [preview, setPreview] = useState<WizardPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  /** Inline overrides for each editable category, keyed by period index. */
  const [overrides, setOverrides] = useState<{
    groceries: Record<number, number>;
    fuel: Record<number, number>;
    tolls: Record<number, number>;
    misc: Record<number, number>;
    miscNote: Record<number, string>;
    savings: Record<number, number>;
  }>({ groceries: {}, fuel: {}, tolls: {}, misc: {}, miscNote: {}, savings: {} });

  /**
   * 0.17.22 — per-run % overrides for the three savings chips
   * (defaults 25/50/75). Empty string = use platform default.
   * `savingsAccountId` is the destination account picked from
   * the user's savings-type accounts; null/undefined = no
   * destination, savings still gets budgeted but unlinked.
   */
  const [lowPctOverride, setLowPctOverride] = useState<string>('');
  const [midPctOverride, setMidPctOverride] = useState<string>('');
  const [highPctOverride, setHighPctOverride] = useState<string>('');
  const [savingsAccountId, setSavingsAccountId] = useState<string>('');

  /**
   * 0.17.8 — accounts the wizard should consider. Loaded from
   * the tenant's account list; defaults to "every account
   * selected". Unchecking an account removes its bills,
   * recurring income, and grocery-spend history from the
   * wizard's data sources. Bills/income with NULL account_id
   * (household-wide) stay regardless — those apply to every
   * account by design.
   */
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    new Set(),
  );
  useEffect(() => {
    void api
      .listAccounts()
      .then((rows) => {
        setAccounts(rows);
        // Default: all accounts included.
        setSelectedAccountIds(new Set(rows.map((a) => a.id)));
      })
      .catch(() => undefined);
  }, []);
  function toggleAccount(id: string) {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allSelected =
    accounts.length > 0 && selectedAccountIds.size === accounts.length;
  function toggleAll() {
    if (allSelected) {
      setSelectedAccountIds(new Set());
    } else {
      setSelectedAccountIds(new Set(accounts.map((a) => a.id)));
    }
  }

  /** Parse a percent-input string. '' or out-of-range -> undefined. */
  function parsePct(s: string): number | undefined {
    if (s.trim() === '') return undefined;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
    return n;
  }

  const loadPreview = useCallback(async () => {
    setPreviewing(true);
    setError(null);
    try {
      // 0.17.8 — when every account is selected (the default),
      // send no filter so the wizard considers everything. When
      // a subset is selected, send the explicit list. Sending
      // an empty list would tell the server "no accounts" which
      // we never want from this UI; the "deselect all" state is
      // already a clear signal that the user wants nothing.
      const accountIds =
        accounts.length > 0 && !allSelected
          ? Array.from(selectedAccountIds)
          : undefined;
      const p = await api.budgetWizardPreview({
        periodType,
        anchor,
        count,
        ...(accountIds ? { accountIds } : {}),
        groceriesOverrideCents: overrides.groceries,
        fuelOverrideCents: overrides.fuel,
        tollsOverrideCents: overrides.tolls,
        miscOverrideCents: overrides.misc,
        miscNoteOverride: overrides.miscNote,
        savingsOverrideCents: overrides.savings,
        savingsLowPctOverride: parsePct(lowPctOverride),
        savingsMidPctOverride: parsePct(midPctOverride),
        savingsHighPctOverride: parsePct(highPctOverride),
      });
      setPreview(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }, [
    periodType,
    anchor,
    count,
    overrides,
    lowPctOverride,
    midPctOverride,
    highPctOverride,
    accounts.length,
    allSelected,
    selectedAccountIds,
  ]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  function override(
    field: 'groceries' | 'fuel' | 'tolls' | 'misc' | 'savings',
    idx: number,
    value: string,
  ) {
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

  function overrideMiscNote(idx: number, value: string) {
    setOverrides((prev) => ({
      ...prev,
      miscNote: { ...prev.miscNote, [idx]: value },
    }));
  }

  function pickSavings(idx: number, cents: number) {
    setOverrides((prev) => ({
      ...prev,
      savings: { ...prev.savings, [idx]: cents },
    }));
  }

  async function commit() {
    setCommitting(true);
    setError(null);
    try {
      // 0.17.8 — same accountIds plumbing as preview so the
      // commit reads the same filtered data the user saw in the
      // preview. (The wizard service technically reads from
      // preview, so this is belt-and-suspenders, but if the
      // server ever re-derives during commit it'll still match.)
      const accountIds =
        accounts.length > 0 && !allSelected
          ? Array.from(selectedAccountIds)
          : undefined;
      const r = await api.budgetWizardCommit({
        name: planName.trim(),
        periodType,
        anchor,
        count,
        ...(accountIds ? { accountIds } : {}),
        savingsAccountId: savingsAccountId === '' ? null : savingsAccountId,
        groceriesOverrideCents: overrides.groceries,
        fuelOverrideCents: overrides.fuel,
        tollsOverrideCents: overrides.tolls,
        miscOverrideCents: overrides.misc,
        miscNoteOverride: overrides.miscNote,
        savingsOverrideCents: overrides.savings,
        savingsLowPctOverride: parsePct(lowPctOverride),
        savingsMidPctOverride: parsePct(midPctOverride),
        savingsHighPctOverride: parsePct(highPctOverride),
      });
      onCommitted({ planId: r.planId, created: r.created, skipped: r.skipped });
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
          {/*
            * 0.17.16 — plan name. Required for commit (server
            * rejects empty/duplicate names with 409). The
            * cadence + anchor + accounts all hang off this
            * named plan.
            */}
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="wiz-name">Plan name</label>
            <input
              id="wiz-name"
              type="text"
              placeholder="e.g. Chase-5793 paycheck cycle"
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              maxLength={120}
              required
            />
          </div>
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
          {/*
            * 0.17.22 — three configurable percentages of post-
            * deduction leftover. Defaults 25/50/75. The Max chip
            * (100%) on each period row is always derived from
            * leftover.
            */}
          <div className="field">
            <label htmlFor="wiz-low-pct">
              Low % of leftover
              <span className="muted">
                {' '}
                {preview ? `(default ${preview.savingsLowPct}%)` : ''}
              </span>
            </label>
            <input
              id="wiz-low-pct"
              type="number"
              min="0"
              max="100"
              step="0.5"
              placeholder={preview ? String(preview.savingsLowPct) : '25'}
              value={lowPctOverride}
              onChange={(e) => setLowPctOverride(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="wiz-mid-pct">
              Mid % of leftover
              <span className="muted">
                {' '}
                {preview ? `(default ${preview.savingsMidPct}%)` : ''}
              </span>
            </label>
            <input
              id="wiz-mid-pct"
              type="number"
              min="0"
              max="100"
              step="0.5"
              placeholder={preview ? String(preview.savingsMidPct) : '50'}
              value={midPctOverride}
              onChange={(e) => setMidPctOverride(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="wiz-high-pct">
              High % of leftover
              <span className="muted">
                {' '}
                {preview ? `(default ${preview.savingsHighPct}%)` : ''}
              </span>
            </label>
            <input
              id="wiz-high-pct"
              type="number"
              min="0"
              max="100"
              step="0.5"
              placeholder={preview ? String(preview.savingsHighPct) : '75'}
              value={highPctOverride}
              onChange={(e) => setHighPctOverride(e.target.value)}
            />
          </div>
          {/*
            * 0.17.22 — savings destination. Filtered to
            * `accounts.type = 'savings'`. If the user has none,
            * the dropdown is empty with a hint to add one.
            */}
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="wiz-savings-acct">
              Savings goes to{' '}
              <span className="muted small">
                · destination for chosen savings amounts
              </span>
            </label>
            <select
              id="wiz-savings-acct"
              value={savingsAccountId}
              onChange={(e) => setSavingsAccountId(e.target.value)}
            >
              <option value="">— No destination —</option>
              {accounts
                .filter((a) => a.type === 'savings')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
            {accounts.filter((a) => a.type === 'savings').length === 0 && (
              <div className="muted small" style={{ marginTop: 4 }}>
                No savings-type accounts configured. Add one on the Accounts
                page if you want to link savings here.
              </div>
            )}
          </div>
          {/*
            * 0.17.8 — accounts to include. Defaults to every account
            * checked. Unchecking removes that account's bills,
            * recurring income, and grocery transactions from the
            * wizard's data sources. Bills/income with no account
            * (household-wide) stay in regardless.
            */}
          {accounts.length > 0 && (
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>
                Include accounts{' '}
                <span className="muted small">
                  · {selectedAccountIds.size} of {accounts.length}
                </span>
              </label>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 12,
                  padding: '8px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  background: 'var(--surface-3)',
                }}
              >
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate =
                        selectedAccountIds.size > 0 && !allSelected;
                    }}
                    onChange={toggleAll}
                  />
                  <strong>{allSelected ? 'Deselect all' : 'Select all'}</strong>
                </label>
                {accounts.map((a) => (
                  <label
                    key={a.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedAccountIds.has(a.id)}
                      onChange={() => toggleAccount(a.id)}
                    />
                    {a.name}
                  </label>
                ))}
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>
                Bills and income that aren't tied to any specific account
                (household-wide) are always included.
              </div>
            </div>
          )}
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
                      <MiscRow
                        cents={p.miscCents}
                        note={p.miscNote}
                        onChangeCents={(v) => override('misc', p.index, v)}
                        onChangeNote={(v) => overrideMiscNote(p.index, v)}
                      />
                      <SavingsRow
                        cents={p.savingsCents}
                        suggestions={p.savingsSuggestions}
                        savingsLowPct={preview.savingsLowPct}
                        savingsMidPct={preview.savingsMidPct}
                        savingsHighPct={preview.savingsHighPct}
                        onChange={(v) => override('savings', p.index, v)}
                        onPick={(c) => pickSavings(p.index, c)}
                      />
                      <tr className="wizard-flex">
                        <td className="muted">Flex (remaining)</td>
                        <td className={`num ${p.flexCents >= 0 ? 'pos' : 'neg'}`}>
                          {formatCents(p.flexCents)}
                        </td>
                        <td className="muted">income − bills − everything above</td>
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
            disabled={!preview || committing || planName.trim().length === 0}
            onClick={() => void commit()}
            title={
              planName.trim().length === 0
                ? 'Enter a plan name first'
                : undefined
            }
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

function MiscRow({
  cents,
  note,
  onChangeCents,
  onChangeNote,
}: {
  cents: number;
  note: string;
  onChangeCents: (v: string) => void;
  onChangeNote: (v: string) => void;
}) {
  return (
    <tr>
      <td>Misc</td>
      <td className="num">
        <input
          type="number"
          step="0.01"
          min="0"
          value={(cents / 100).toFixed(2)}
          onChange={(e) => onChangeCents(e.target.value)}
          className="wizard-amount"
        />
      </td>
      <td>
        <input
          type="text"
          placeholder="what for? (oil change, gift, etc.)"
          value={note}
          onChange={(e) => onChangeNote(e.target.value)}
          className="wizard-note"
        />
      </td>
    </tr>
  );
}

function SavingsRow({
  cents,
  suggestions,
  savingsLowPct,
  savingsMidPct,
  savingsHighPct,
  onChange,
  onPick,
}: {
  cents: number;
  suggestions: {
    goalRequiredCents: number;
    pctLowCents: number;
    pctMidCents: number;
    pctHighCents: number;
    maxCents: number;
  };
  savingsLowPct: number;
  savingsMidPct: number;
  savingsHighPct: number;
  onChange: (v: string) => void;
  onPick: (cents: number) => void;
}) {
  return (
    <tr>
      <td>Savings</td>
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
      <td className="wizard-savings-pickers">
        {/*
          * 0.17.22 — five chips. Goal-required first (from goals
          * data), then three configurable leftover percentages
          * (defaults 25/50/75), then Max (100% of leftover).
          */}
        <SuggestionChip
          label="Goal-required"
          cents={suggestions.goalRequiredCents}
          onPick={onPick}
        />
        <SuggestionChip
          label={`${savingsLowPct}%`}
          cents={suggestions.pctLowCents}
          onPick={onPick}
        />
        <SuggestionChip
          label={`${savingsMidPct}%`}
          cents={suggestions.pctMidCents}
          onPick={onPick}
        />
        <SuggestionChip
          label={`${savingsHighPct}%`}
          cents={suggestions.pctHighCents}
          onPick={onPick}
        />
        <SuggestionChip label="Max" cents={suggestions.maxCents} onPick={onPick} />
      </td>
    </tr>
  );
}

function SuggestionChip({
  label,
  cents,
  onPick,
}: {
  label: string;
  cents: number;
  onPick: (cents: number) => void;
}) {
  return (
    <button
      type="button"
      className="wizard-chip"
      onClick={() => onPick(cents)}
      title={`Click to use ${(cents / 100).toFixed(2)} as Savings for this period`}
    >
      <span className="muted">{label}:</span> ${(cents / 100).toFixed(2)}
    </button>
  );
}
