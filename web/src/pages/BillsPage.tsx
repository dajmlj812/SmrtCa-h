import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type Bill,
  type BillFrequency,
  type IncomeFrequency,
  type RecurringIncome,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showBillForm, setShowBillForm] = useState(false);
  const [showIncomeForm, setShowIncomeForm] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [b, i] = await Promise.all([
        api.listBills(),
        api.listRecurringIncome(),
      ]);
      setBills(b);
      setIncome(i);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
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
