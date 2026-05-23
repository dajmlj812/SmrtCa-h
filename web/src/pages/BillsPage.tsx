import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type Bill,
  type BillFrequency,
  type IncomeFrequency,
  type RecurringIncome,
  type RecurringSuggestion,
} from '../api';
import { formatCents, formatDate } from '../format';

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
  const [suggestions, setSuggestions] = useState<RecurringSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showBillForm, setShowBillForm] = useState(false);
  const [showIncomeForm, setShowIncomeForm] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [confirming, setConfirming] = useState<RecurringSuggestion | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [b, i, s] = await Promise.all([
        api.listBills(),
        api.listRecurringIncome(),
        api.listRecurringSuggestions('pending'),
      ]);
      setBills(b);
      setIncome(i);
      setSuggestions(s);
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

  async function deleteIncome(id: string) {
    if (!window.confirm('Delete this recurring income entry?')) return;
    try {
      await api.deleteRecurringIncome(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
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
          <div className="suggestion-list">
            {suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                onConfirm={() => setConfirming(s)}
                onReject={() => void rejectSuggestion(s.id)}
                onSnooze={() => void snoozeSuggestion(s.id)}
              />
            ))}
          </div>
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
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Frequency</th>
                  <th>Next due</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id} className={b.active ? '' : 'muted-row'}>
                    <td>{b.name}</td>
                    <td>{b.frequency}</td>
                    <td className="nowrap">{formatDate(b.next_due_date)}</td>
                    <td className="num neg">{formatCents(-b.amount_cents)}</td>
                    <td>{b.active ? 'Active' : 'Closed'}</td>
                    <td>
                      {b.active && (
                        <button
                          className="btn-link"
                          type="button"
                          onClick={() => void markPaid(b.id)}
                        >
                          Mark paid
                        </button>
                      )}
                      <button
                        className="btn-link danger"
                        type="button"
                        onClick={() => void deleteBill(b.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Frequency</th>
                  <th>Next expected</th>
                  <th className="num">Amount</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {income.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    <td>{i.frequency}</td>
                    <td className="nowrap">{formatDate(i.next_expected_date)}</td>
                    <td className="num pos">{formatCents(i.amount_cents)}</td>
                    <td>
                      <button
                        className="btn-link danger"
                        type="button"
                        onClick={() => void deleteIncome(i.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
    </div>
  );
}

function SuggestionCard({
  suggestion,
  onConfirm,
  onReject,
  onSnooze,
}: {
  suggestion: RecurringSuggestion;
  onConfirm: () => void;
  onReject: () => void;
  onSnooze: () => void;
}) {
  const pct = Math.round(Number(suggestion.confidence) * 100);
  return (
    <div className="card suggestion-card">
      <div className="suggestion-head">
        <div>
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
