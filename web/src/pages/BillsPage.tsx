import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type Account,
  type Bill,
  type BillFrequency,
  type IncomeFrequency,
  type RecurringIncome,
  type RecurringSuggestion,
  type ReportColumn,
} from '../api';
import { formatCents, formatDate } from '../format';
import { FilterableTable } from '../components/FilterableTable';
import { CancelInfoModal } from '../components/CancelInfoModal';
import { ScheduleChangeModal } from '../components/ScheduleChangeModal';

const BILL_TABLE_COLUMNS: ReportColumn[] = [
  { key: 'name', label: 'Name', type: 'string' },
  { key: 'frequency', label: 'Frequency', type: 'string' },
  { key: 'next_due_date', label: 'Next due', type: 'date' },
  { key: 'amount_cents', label: 'Amount', type: 'cents' },
  // 0.17.18 — display the bill's account so users can spot the
  // ones that need fixing. Editable via the rowActions picker.
  { key: 'account_name', label: 'Account', type: 'string' },
  { key: 'status_label', label: 'Status', type: 'string' },
];
const INCOME_TABLE_COLUMNS: ReportColumn[] = [
  { key: 'name', label: 'Name', type: 'string' },
  { key: 'frequency', label: 'Frequency', type: 'string' },
  { key: 'next_expected_date', label: 'Next expected', type: 'date' },
  { key: 'amount_cents', label: 'Amount', type: 'cents' },
  { key: 'account_name', label: 'Account', type: 'string' },
];

function formatTableCell(col: ReportColumn, raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  switch (col.type) {
    case 'cents':
      return formatCents(typeof raw === 'number' ? raw : Number(raw));
    case 'date':
      return formatDate(typeof raw === 'string' ? raw : null);
    default:
      return String(raw);
  }
}

const BILL_FREQUENCIES: BillFrequency[] = [
  'monthly',
  'weekly',
  'biweekly',
  'yearly',
  'one-time',
];
const INCOME_FREQUENCIES: IncomeFrequency[] = [
  'monthly',
  'weekly',
  'biweekly',
  'yearly',
];

export function BillsPage() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [income, setIncome] = useState<RecurringIncome[]>([]);
  // 0.17.18 — accounts list for the row-level account picker.
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [suggestions, setSuggestions] = useState<RecurringSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showBillForm, setShowBillForm] = useState(false);
  const [showIncomeForm, setShowIncomeForm] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [confirming, setConfirming] = useState<RecurringSuggestion | null>(null);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(
    new Set(),
  );
  const [bulkBusy, setBulkBusy] = useState(false);
  // 0.18.1 — cancel-info modal target.
  const [cancelingBill, setCancelingBill] = useState<Bill | null>(null);
  // 0.18.13 — schedule-changes modal target. Can be a Bill or a
  // RecurringIncome; we discriminate with the `kind` field.
  const [scheduleTarget, setScheduleTarget] = useState<
    | { kind: 'bill'; row: Bill }
    | { kind: 'income'; row: RecurringIncome }
    | null
  >(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [b, i, s, a] = await Promise.all([
        api.listBills(),
        api.listRecurringIncome(),
        api.listRecurringSuggestions('pending'),
        api.listAccounts(),
      ]);
      setBills(b);
      setIncome(i);
      setSuggestions(s);
      setAccounts(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function runDetect() {
    setDetecting(true);
    setError(null);
    try {
      const r = await api.detectRecurring();
      if (r.inserted === 0 && r.candidates === 0) {
        setError('No recurring patterns detected — need at least 3 occurrences on the same merchant.');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Detection failed');
    } finally {
      setDetecting(false);
    }
  }

  async function rejectSuggestion(id: string) {
    try {
      await api.rejectRecurringSuggestion(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reject failed');
    }
  }

  async function snoozeSuggestion(id: string) {
    try {
      await api.snoozeRecurringSuggestion(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snooze failed');
    }
  }

  function toggleSuggestion(id: string) {
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllSuggestions() {
    setSelectedSuggestions((prev) => {
      const allIds = suggestions.map((s) => s.id);
      const allOn = allIds.every((id) => prev.has(id));
      if (allOn) return new Set();
      return new Set(allIds);
    });
  }

  async function bulkAction(action: 'confirm' | 'reject' | 'snooze') {
    if (selectedSuggestions.size === 0) return;
    setBulkBusy(true);
    setError(null);
    try {
      const r = await api.bulkRecurringAction(
        Array.from(selectedSuggestions),
        action,
      );
      const count =
        action === 'confirm' ? r.confirmed ?? 0 : r.updated ?? 0;
      setSelectedSuggestions(new Set());
      if (action === 'confirm' && r.skipped && r.skipped.length > 0) {
        setError(
          `Confirmed ${count}; skipped ${r.skipped.length} (${r.skipped[0]!.reason}…)`,
        );
      }
      await load();
      void count; // counts surface via the panel re-render
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk action failed');
    } finally {
      setBulkBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function markPaid(id: string) {
    try {
      await api.markBillPaid(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mark-paid failed');
    }
  }

  async function deleteBill(id: string) {
    if (!window.confirm('Delete this bill?')) return;
    try {
      await api.deleteBill(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  // 0.17.24 — clone a bill (multiple users sharing one account
  // but paying separate subscriptions, e.g. two Netflix subs).
  async function duplicateBill(id: string) {
    try {
      await api.duplicateBill(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Duplicate failed');
    }
  }

  async function deleteIncome(id: string) {
    if (!window.confirm('Delete this recurring income entry?')) return;
    try {
      await api.deleteRecurringIncome(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  // 0.17.18 — update a bill's account_id; null = "no account".
  async function setBillAccount(id: string, accountId: string | null) {
    try {
      await api.updateBill(id, { accountId });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Account update failed');
    }
  }
  async function setIncomeAccount(id: string, accountId: string | null) {
    try {
      await api.updateRecurringIncome(id, { accountId });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Account update failed');
    }
  }

  // 0.17.23 — inline frequency editor for bills + income.
  async function setBillFrequency(id: string, frequency: BillFrequency) {
    try {
      await api.updateBill(id, { frequency });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Frequency update failed');
    }
  }
  async function setIncomeFrequency(id: string, frequency: IncomeFrequency) {
    try {
      await api.updateRecurringIncome(id, { frequency });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Frequency update failed');
    }
  }

  function accountName(id: string | null): string {
    if (id === null) return '—';
    return accounts.find((a) => a.id === id)?.name ?? '(removed)';
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Bills &amp; recurring income</h1>
          <div className="subtitle">
            Drives the upcoming-bills panel and the 90-day cash-flow forecast.
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="page-section">
        <div className="page-section-head">
          <h2>Suggested recurring items</h2>
          <button
            className="btn secondary"
            type="button"
            disabled={detecting}
            onClick={() => void runDetect()}
          >
            {detecting ? 'Scanning…' : 'Detect recurring'}
          </button>
        </div>
        {suggestions.length === 0 ? (
          <p className="empty">
            No pending suggestions. Click <strong>Detect recurring</strong> to scan
            your transactions for repeating patterns.
          </p>
        ) : (
          <>
            <div className="suggestion-bulk-bar">
              <label>
                <input
                  type="checkbox"
                  checked={
                    suggestions.length > 0 &&
                    suggestions.every((s) => selectedSuggestions.has(s.id))
                  }
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        selectedSuggestions.size > 0 &&
                        !suggestions.every((s) => selectedSuggestions.has(s.id));
                  }}
                  onChange={toggleAllSuggestions}
                />{' '}
                Select all
              </label>
              <span className="muted">
                {selectedSuggestions.size} selected
              </span>
              <div className="spacer" />
              <button
                className="btn"
                type="button"
                disabled={bulkBusy || selectedSuggestions.size === 0}
                onClick={() => void bulkAction('confirm')}
                title="Confirm selected — each becomes a bill or recurring income with detector defaults"
              >
                Confirm selected
              </button>
              <button
                className="btn secondary"
                type="button"
                disabled={bulkBusy || selectedSuggestions.size === 0}
                onClick={() => void bulkAction('snooze')}
              >
                Snooze selected
              </button>
              <button
                className="btn danger"
                type="button"
                disabled={bulkBusy || selectedSuggestions.size === 0}
                onClick={() => void bulkAction('reject')}
              >
                Reject selected
              </button>
            </div>
            <div className="suggestion-list">
              {suggestions.map((s) => (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  selected={selectedSuggestions.has(s.id)}
                  onToggle={() => toggleSuggestion(s.id)}
                  onConfirm={() => setConfirming(s)}
                  onReject={() => void rejectSuggestion(s.id)}
                  onSnooze={() => void snoozeSuggestion(s.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="page-section">
        <div className="page-section-head">
          <h2>Bills</h2>
          <button className="btn" onClick={() => setShowBillForm(true)}>
            Add bill
          </button>
        </div>
        {loading ? (
          <p className="empty">Loading…</p>
        ) : bills.length === 0 ? (
          <p className="empty">No bills yet.</p>
        ) : (
          <FilterableTable
            columns={BILL_TABLE_COLUMNS}
            rows={bills.map((b) => ({
              ...b,
              // Display amount as a negative outflow to match the old table.
              amount_cents: -b.amount_cents,
              status_label: b.active ? 'Active' : 'Closed',
              account_name: accountName(b.account_id),
            }))}
            formatCell={formatTableCell}
            storageKey="bills:list"
            rowActions={(row) => {
              const r = row as unknown as Bill & { status_label: string };
              return (
                <>
                  <AccountPicker
                    value={r.account_id}
                    accounts={accounts}
                    onChange={(v) => void setBillAccount(r.id, v)}
                  />
                  <FrequencyPicker
                    value={r.frequency}
                    options={BILL_FREQUENCIES}
                    onChange={(v) => void setBillFrequency(r.id, v as BillFrequency)}
                  />
                  {r.active && (
                    <button
                      className="btn-link"
                      type="button"
                      onClick={() => void markPaid(r.id)}
                    >
                      Mark paid
                    </button>
                  )}
                  <button
                    className="btn-link"
                    type="button"
                    onClick={() => setCancelingBill(r)}
                    title="How to cancel this subscription"
                  >
                    Cancel info
                    {(r.cancel_url || r.cancel_steps || r.cancel_email_template) && (
                      <span
                        className="badge-dot"
                        aria-label="cancellation info saved"
                      />
                    )}
                  </button>
                  <button
                    className="btn-link"
                    type="button"
                    onClick={() => void duplicateBill(r.id)}
                    title='Clone for a second person on the same account'
                  >
                    Duplicate
                  </button>
                  <button
                    className="btn-link"
                    type="button"
                    onClick={() => setScheduleTarget({ kind: 'bill', row: r })}
                    title='Schedule a future amount or frequency change'
                  >
                    Schedule change
                  </button>
                  <button
                    className="btn-link danger"
                    type="button"
                    onClick={() => void deleteBill(r.id)}
                  >
                    Delete
                  </button>
                </>
              );
            }}
          />
        )}
      </div>

      <div className="page-section">
        <div className="page-section-head">
          <h2>Recurring income</h2>
          <button className="btn" onClick={() => setShowIncomeForm(true)}>
            Add income
          </button>
        </div>
        {loading ? null : income.length === 0 ? (
          <p className="empty">No recurring income yet.</p>
        ) : (
          <FilterableTable
            columns={INCOME_TABLE_COLUMNS}
            rows={income.map((i) => ({
              ...i,
              account_name: accountName(i.account_id),
            })) as unknown as Array<Record<string, unknown>>}
            formatCell={formatTableCell}
            storageKey="income:list"
            rowActions={(row) => {
              const r = row as unknown as RecurringIncome;
              return (
                <>
                  <AccountPicker
                    value={r.account_id}
                    accounts={accounts}
                    onChange={(v) => void setIncomeAccount(r.id, v)}
                  />
                  <FrequencyPicker
                    value={r.frequency}
                    options={INCOME_FREQUENCIES}
                    onChange={(v) => void setIncomeFrequency(r.id, v as IncomeFrequency)}
                  />
                  <button
                    className="btn-link"
                    type="button"
                    onClick={() => setScheduleTarget({ kind: 'income', row: r })}
                    title='Schedule a future amount or frequency change'
                  >
                    Schedule change
                  </button>
                  <button
                    className="btn-link danger"
                    type="button"
                    onClick={() => void deleteIncome(r.id)}
                  >
                    Delete
                  </button>
                </>
              );
            }}
          />
        )}
      </div>

      {showBillForm && (
        <BillForm
          onClose={() => setShowBillForm(false)}
          onSaved={() => {
            setShowBillForm(false);
            void load();
          }}
        />
      )}
      {showIncomeForm && (
        <IncomeForm
          onClose={() => setShowIncomeForm(false)}
          onSaved={() => {
            setShowIncomeForm(false);
            void load();
          }}
        />
      )}
      {confirming && (
        <ConfirmSuggestionModal
          suggestion={confirming}
          onClose={() => setConfirming(null)}
          onConfirmed={() => {
            setConfirming(null);
            void load();
          }}
        />
      )}
      {cancelingBill && (
        <CancelInfoModal
          bill={cancelingBill}
          onClose={() => setCancelingBill(null)}
          onSaved={(updated) => {
            setCancelingBill(null);
            setBills((prev) =>
              prev.map((b) => (b.id === updated.id ? updated : b)),
            );
          }}
        />
      )}
      {scheduleTarget && (
        <ScheduleChangeModal
          target={{
            kind: scheduleTarget.kind,
            id: scheduleTarget.row.id,
            name: scheduleTarget.row.name,
          }}
          currentAmountCents={scheduleTarget.row.amount_cents}
          currentFrequency={scheduleTarget.row.frequency}
          onClose={() => setScheduleTarget(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

function SuggestionCard({
  suggestion,
  selected,
  onToggle,
  onConfirm,
  onReject,
  onSnooze,
}: {
  suggestion: RecurringSuggestion;
  selected: boolean;
  onToggle: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onSnooze: () => void;
}) {
  const pct = Math.round(Number(suggestion.confidence) * 100);
  return (
    <div className={`card suggestion-card ${selected ? 'selected' : ''}`}>
      <div className="suggestion-head">
        <div>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${suggestion.name}`}
            style={{ marginRight: 8 }}
          />
          <span className={`pill ${suggestion.kind === 'income' ? 'pos' : 'neg'}-pill`}>
            {suggestion.kind === 'income' ? 'Income' : 'Bill'}
          </span>
          <span className="suggestion-name">{suggestion.name}</span>
        </div>
        <span className={`num ${suggestion.kind === 'income' ? 'pos' : 'neg'}`}>
          {formatCents(
            suggestion.kind === 'income'
              ? suggestion.amount_cents
              : -suggestion.amount_cents,
          )}
        </span>
      </div>
      <div className="muted suggestion-meta">
        Looks <strong>{suggestion.detected_frequency}</strong> · {pct}% confidence ·
        {' '}
        {suggestion.sample_txn_ids.length} sample
        {suggestion.sample_txn_ids.length === 1 ? '' : 's'}
      </div>
      <div className="suggestion-actions">
        <button className="btn" type="button" onClick={onConfirm}>
          Confirm
        </button>
        <button className="btn secondary" type="button" onClick={onSnooze}>
          Snooze
        </button>
        <button className="btn-link danger" type="button" onClick={onReject}>
          Not recurring
        </button>
      </div>
    </div>
  );
}

function ConfirmSuggestionModal({
  suggestion,
  onClose,
  onConfirmed,
}: {
  suggestion: RecurringSuggestion;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const validFreqs: Array<{ value: string; label: string }> =
    suggestion.kind === 'bill'
      ? [
          { value: 'monthly', label: 'Monthly' },
          { value: 'biweekly', label: 'Bi-weekly' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'yearly', label: 'Yearly' },
          { value: 'one-time', label: 'One-time' },
        ]
      : [
          { value: 'monthly', label: 'Monthly' },
          { value: 'biweekly', label: 'Bi-weekly' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'yearly', label: 'Yearly' },
        ];

  const initialFreq = validFreqs.some(
    (f) => f.value === suggestion.detected_frequency,
  )
    ? suggestion.detected_frequency
    : 'monthly';

  const [name, setName] = useState(suggestion.name);
  const [frequency, setFrequency] = useState<string>(initialFreq);
  const [nextDate, setNextDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.confirmRecurringSuggestion(suggestion.id, {
        name,
        frequency,
        ...(nextDate ? { nextDate } : {}),
      });
      onConfirmed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirm failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>
            Confirm {suggestion.kind === 'income' ? 'recurring income' : 'bill'}
          </h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form onSubmit={submit}>
          {error && <div className="banner error">{error}</div>}
          <div className="muted" style={{ marginBottom: 12 }}>
            Detector saw {suggestion.sample_txn_ids.length} matching transactions
            at amount {formatCents(suggestion.amount_cents)} on a{' '}
            <strong>{suggestion.detected_frequency}</strong> cadence
            ({Math.round(Number(suggestion.confidence) * 100)}% confidence).
            Adjust below and confirm — that creates the matching{' '}
            {suggestion.kind === 'income' ? 'recurring income' : 'bill'} row.
          </div>
          <div className="field">
            <label htmlFor="cs-name">Name</label>
            <input
              id="cs-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="cs-freq">Frequency</label>
              <select
                id="cs-freq"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
              >
                {validFreqs.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cs-next">
                Next {suggestion.kind === 'income' ? 'expected' : 'due'} date
                <span className="muted"> (optional)</span>
              </label>
              <input
                id="cs-next"
                type="date"
                value={nextDate}
                onChange={(e) => setNextDate(e.target.value)}
              />
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? 'Confirming…' : 'Confirm'}
            </button>
            <button className="btn secondary" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function BillForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [dollars, setDollars] = useState('');
  const [frequency, setFrequency] = useState<BillFrequency>('monthly');
  const [nextDue, setNextDue] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const cents = Math.round(Number(dollars) * 100);
      if (!Number.isFinite(cents) || cents <= 0)
        throw new Error('Amount must be > 0');
      await api.createBill({
        name,
        amountCents: cents,
        frequency,
        nextDueDate: nextDue,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>New bill</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form onSubmit={submit}>
          {error && <div className="banner error">{error}</div>}
          <div className="field">
            <label htmlFor="bill-name">Name</label>
            <input
              id="bill-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="bill-amt">Amount ($)</label>
              <input
                id="bill-amt"
                type="number"
                step="0.01"
                min="0.01"
                value={dollars}
                onChange={(e) => setDollars(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="bill-freq">Frequency</label>
              <select
                id="bill-freq"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as BillFrequency)}
              >
                {BILL_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="bill-date">Next due</label>
              <input
                id="bill-date"
                type="date"
                value={nextDue}
                onChange={(e) => setNextDue(e.target.value)}
                required
              />
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Create bill'}
            </button>
            <button className="btn secondary" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function IncomeForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [dollars, setDollars] = useState('');
  const [frequency, setFrequency] = useState<IncomeFrequency>('monthly');
  const [nextExpected, setNextExpected] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const cents = Math.round(Number(dollars) * 100);
      if (!Number.isFinite(cents) || cents <= 0)
        throw new Error('Amount must be > 0');
      await api.createRecurringIncome({
        name,
        amountCents: cents,
        frequency,
        nextExpectedDate: nextExpected,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>New recurring income</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form onSubmit={submit}>
          {error && <div className="banner error">{error}</div>}
          <div className="field">
            <label htmlFor="inc-name">Name</label>
            <input
              id="inc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="inc-amt">Amount ($)</label>
              <input
                id="inc-amt"
                type="number"
                step="0.01"
                min="0.01"
                value={dollars}
                onChange={(e) => setDollars(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="inc-freq">Frequency</label>
              <select
                id="inc-freq"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as IncomeFrequency)}
              >
                {INCOME_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="inc-date">Next expected</label>
              <input
                id="inc-date"
                type="date"
                value={nextExpected}
                onChange={(e) => setNextExpected(e.target.value)}
                required
              />
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Create income'}
            </button>
            <button className="btn secondary" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * 0.17.18 — inline account picker for the bill + recurring-income
 * rowActions. Renders a tiny <select> with the current account
 * pre-selected (or "— None —" when null). Calling `onChange`
 * persists the new value through the parent's API call.
 */
function AccountPicker({
  value,
  accounts,
  onChange,
}: {
  value: string | null;
  accounts: Account[];
  onChange: (next: string | null) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      style={{ fontSize: '0.85em', padding: '2px 6px', maxWidth: 200 }}
      title="Change the account this row is tied to"
    >
      <option value="">— No account —</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

/**
 * 0.17.23 — inline frequency picker for bills + recurring income.
 * Caller passes the allowed options (bills include 'one-time';
 * income does not).
 */
function FrequencyPicker<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      style={{ fontSize: '0.85em', padding: '2px 6px' }}
      title="Change how often this row recurs"
    >
      {options.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
    </select>
  );
}
