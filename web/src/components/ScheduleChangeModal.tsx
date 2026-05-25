import { useEffect, useState, type FormEvent } from 'react';
import { api, type ScheduleChange } from '../api';
import { formatCents, formatDate } from '../format';

/**
 * 0.18.13 — modal for managing future-effective changes to a bill or
 * a recurring-income item.
 *
 * Listed in effective_date order; the user can add a new change or
 * remove an existing unapplied one. Applied changes are visible in
 * a separate "Applied changes" section so the operator has a
 * history of what's happened to this item over time without losing
 * the audit trail.
 *
 * Recurring income deliberately disables the "one-time" frequency
 * option — server-side validation also rejects it, but failing fast
 * in the UI keeps the form honest.
 */

type Frequency = 'monthly' | 'weekly' | 'biweekly' | 'yearly' | 'one-time';
const FREQ_OPTIONS_BILL: { value: Frequency | ''; label: string }[] = [
  { value: '', label: '(no change)' },
  { value: 'monthly', label: 'monthly' },
  { value: 'weekly', label: 'weekly' },
  { value: 'biweekly', label: 'biweekly' },
  { value: 'yearly', label: 'yearly' },
  { value: 'one-time', label: 'one-time' },
];
const FREQ_OPTIONS_INCOME: { value: Frequency | ''; label: string }[] =
  FREQ_OPTIONS_BILL.filter((o) => o.value !== 'one-time');

interface Props {
  target: { kind: 'bill' | 'income'; id: string; name: string };
  /** Current parent amount + frequency, shown in the header for context. */
  currentAmountCents: number;
  currentFrequency: Frequency;
  onClose: () => void;
  /** Called after the modal mutates anything, so the parent can refresh. */
  onChanged?: () => void;
}

export function ScheduleChangeModal({
  target,
  currentAmountCents,
  currentFrequency,
  onClose,
  onChanged,
}: Props) {
  const [changes, setChanges] = useState<ScheduleChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-change form state.
  const today = new Date().toISOString().slice(0, 10);
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [newAmount, setNewAmount] = useState('');
  const [newFreq, setNewFreq] = useState<Frequency | ''>('');
  const [note, setNote] = useState('');

  const freqOptions =
    target.kind === 'bill' ? FREQ_OPTIONS_BILL : FREQ_OPTIONS_INCOME;

  async function refresh() {
    setError(null);
    try {
      const fn =
        target.kind === 'bill'
          ? api.listBillScheduleChanges
          : api.listIncomeScheduleChanges;
      setChanges(await fn(target.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load changes');
    }
  }
  useEffect(() => {
    void refresh();
  }, [target.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!effectiveDate) {
      setError('Effective date is required');
      return;
    }
    const amountCents =
      newAmount.trim() === ''
        ? null
        : Math.round(Number(newAmount) * 100);
    if (newAmount.trim() !== '' && (!Number.isFinite(amountCents!) || amountCents! <= 0)) {
      setError('Amount must be a positive number');
      return;
    }
    if (amountCents === null && newFreq === '') {
      setError('Set a new amount, a new frequency, or both');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fn =
        target.kind === 'bill'
          ? api.addBillScheduleChange
          : api.addIncomeScheduleChange;
      await fn(target.id, {
        effective_date: effectiveDate,
        new_amount_cents: amountCents,
        new_frequency: newFreq === '' ? null : (newFreq as Frequency),
        note: note.trim() === '' ? null : note.trim(),
      });
      setNewAmount('');
      setNewFreq('');
      setNote('');
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save change');
    } finally {
      setBusy(false);
    }
  }

  async function remove(changeId: string) {
    if (!window.confirm('Remove this scheduled change?')) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteScheduleChange(changeId);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setBusy(false);
    }
  }

  const pending = (changes ?? []).filter((c) => c.applied_at === null);
  const applied = (changes ?? []).filter((c) => c.applied_at !== null);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>Scheduled changes</h2>
            <div className="modal-subtitle">
              {target.name} · currently <strong>{formatCents(currentAmountCents)}</strong>{' '}
              ({currentFrequency})
            </div>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>✕</button>
        </header>

        {error && <div className="banner error">{error}</div>}

        {/* Pending changes */}
        <h3 className="schedule-change-section-title">
          Upcoming
          <span className="muted small"> · take effect on or after the listed date</span>
        </h3>
        {changes === null ? (
          <p className="empty">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="empty">No upcoming changes scheduled.</p>
        ) : (
          <table className="txn-table" style={{ marginBottom: 16 }}>
            <thead>
              <tr>
                <th>Effective</th>
                <th className="num">New amount</th>
                <th>New frequency</th>
                <th>Note</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((c) => (
                <tr key={c.id}>
                  <td>{formatDate(c.effective_date)}</td>
                  <td className="num">
                    {c.new_amount_cents != null ? formatCents(c.new_amount_cents) : <span className="muted">—</span>}
                  </td>
                  <td>{c.new_frequency ?? <span className="muted">—</span>}</td>
                  <td>{c.note ?? <span className="muted">—</span>}</td>
                  <td>
                    <button
                      className="btn-link danger"
                      type="button"
                      onClick={() => void remove(c.id)}
                      disabled={busy}
                      title="Remove this scheduled change"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Add a new change */}
        <form onSubmit={submit} className="form-grid schedule-change-form">
          <div className="field">
            <label>Effective date</label>
            <input
              type="date"
              value={effectiveDate}
              min={today}
              onChange={(e) => setEffectiveDate(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label>New amount ($)</label>
            <input
              inputMode="decimal"
              placeholder="leave blank to keep current"
              value={newAmount}
              onChange={(e) => setNewAmount(e.target.value)}
            />
          </div>
          <div className="field">
            <label>New frequency</label>
            <select value={newFreq} onChange={(e) => setNewFreq(e.target.value as Frequency | '')}>
              {freqOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Note (optional)</label>
            <input
              type="text"
              placeholder="e.g. lease renewal, raise, promo expires"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={400}
            />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Schedule change'}
            </button>
          </div>
        </form>

        {/* History of applied changes */}
        {applied.length > 0 && (
          <details className="schedule-change-history">
            <summary>
              {applied.length} historical change{applied.length === 1 ? '' : 's'}
            </summary>
            <table className="txn-table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Effective</th>
                  <th className="num">Set amount to</th>
                  <th>Frequency</th>
                  <th>Applied</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {applied.map((c) => (
                  <tr key={c.id}>
                    <td>{formatDate(c.effective_date)}</td>
                    <td className="num">
                      {c.new_amount_cents != null ? formatCents(c.new_amount_cents) : '—'}
                    </td>
                    <td>{c.new_frequency ?? '—'}</td>
                    <td>{c.applied_at ? formatDate(c.applied_at) : '—'}</td>
                    <td>{c.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </div>
  );
}
