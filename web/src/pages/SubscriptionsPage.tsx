import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type Bill,
  type BillFrequency,
  type BillReviewStatus,
} from '../api';
import { formatCents, formatDate } from '../format';

const RECURRING_FREQUENCIES: BillFrequency[] = [
  'weekly',
  'biweekly',
  'monthly',
  'yearly',
];

const STATUS_LABEL: Record<BillReviewStatus, string> = {
  active: 'Active',
  review: 'Needs review',
  cancel: 'Cancel',
  alter: 'Alter service',
  keep: 'Keep',
};

const STATUS_ORDER: BillReviewStatus[] = [
  'review',
  'cancel',
  'alter',
  'active',
  'keep',
];

// Roughly annualize a recurring amount, then divide by 12 to get a
// per-month equivalent for cross-cadence comparison. one-time bills
// don't have a sensible monthly equivalent — we return null and the UI
// just shows a dash.
function monthlyEquivalentCents(b: Bill): number | null {
  switch (b.frequency) {
    case 'monthly':
      return b.amount_cents;
    case 'yearly':
      return Math.round(b.amount_cents / 12);
    case 'biweekly':
      return Math.round((b.amount_cents * 26) / 12);
    case 'weekly':
      return Math.round((b.amount_cents * 52) / 12);
    case 'one-time':
      return null;
  }
}

export function SubscriptionsPage() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<Bill | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const b = await api.listBills();
      setBills(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load bills');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function setStatus(
    id: string,
    status: BillReviewStatus,
    note?: string | null,
  ) {
    try {
      const updated = await api.setBillReview(id, { status, ...(note !== undefined ? { note } : {}) });
      setBills((prev) => prev.map((b) => (b.id === id ? updated : b)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  const recurring = useMemo(
    () =>
      bills.filter(
        (b) => RECURRING_FREQUENCIES.includes(b.frequency) && b.active,
      ),
    [bills],
  );
  const queue = useMemo(
    () =>
      recurring.filter((b) =>
        ['review', 'cancel', 'alter'].includes(b.review_status),
      ),
    [recurring],
  );
  const settled = useMemo(
    () =>
      recurring.filter(
        (b) => b.review_status === 'active' || b.review_status === 'keep',
      ),
    [recurring],
  );

  const monthlyTotalActive = settled.reduce((sum, b) => {
    if (b.review_status !== 'active') return sum;
    const m = monthlyEquivalentCents(b);
    return sum + (m ?? 0);
  }, 0);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Subscriptions</h1>
          <div className="subtitle">
            Every confirmed recurring bill in one place. Flag the ones you
            don't actively use — cancel them, downgrade, or keep them with
            a note about why.
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="page-section">
        <div className="page-section-head">
          <h2>Action queue</h2>
          <span className="muted">
            {queue.length} subscription{queue.length === 1 ? '' : 's'} flagged
          </span>
        </div>
        {loading ? (
          <p className="empty">Loading…</p>
        ) : queue.length === 0 ? (
          <p className="empty">
            Nothing flagged. Click <strong>Flag for review</strong> below on
            anything you're not sure you still need.
          </p>
        ) : (
          <div className="subscription-list">
            {queue
              .slice()
              .sort(
                (a, b) =>
                  STATUS_ORDER.indexOf(a.review_status) -
                  STATUS_ORDER.indexOf(b.review_status),
              )
              .map((b) => (
                <SubscriptionCard
                  key={b.id}
                  bill={b}
                  onSetStatus={(s) => void setStatus(b.id, s)}
                  onEditNote={() => setNoteFor(b)}
                />
              ))}
          </div>
        )}
      </div>

      <div className="page-section">
        <div className="page-section-head">
          <h2>Active subscriptions</h2>
          <span className="muted">
            {settled.length} total · ≈ {formatCents(monthlyTotalActive)}/month
          </span>
        </div>
        {loading ? null : settled.length === 0 ? (
          <p className="empty">
            No active subscriptions. Confirm recurring suggestions on the{' '}
            <strong>Bills</strong> page to populate this list.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Frequency</th>
                  <th>Next due</th>
                  <th className="num">Per cycle</th>
                  <th className="num">≈ Monthly</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {settled.map((b) => {
                  const monthly = monthlyEquivalentCents(b);
                  return (
                    <tr key={b.id}>
                      <td>{b.name}</td>
                      <td>{b.frequency}</td>
                      <td className="nowrap">{formatDate(b.next_due_date)}</td>
                      <td className="num neg">{formatCents(-b.amount_cents)}</td>
                      <td className="num neg">
                        {monthly === null ? '—' : formatCents(-monthly)}
                      </td>
                      <td>{STATUS_LABEL[b.review_status]}</td>
                      <td>
                        <button
                          className="btn-link"
                          type="button"
                          onClick={() => void setStatus(b.id, 'review')}
                        >
                          Flag for review
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {noteFor && (
        <NoteModal
          bill={noteFor}
          onClose={() => setNoteFor(null)}
          onSaved={(note) => {
            void setStatus(noteFor.id, noteFor.review_status, note);
            setNoteFor(null);
          }}
        />
      )}
    </div>
  );
}

function SubscriptionCard({
  bill,
  onSetStatus,
  onEditNote,
}: {
  bill: Bill;
  onSetStatus: (status: BillReviewStatus) => void;
  onEditNote: () => void;
}) {
  const monthly = monthlyEquivalentCents(bill);
  const monthlyLabel = monthly === null ? null : formatCents(-monthly);
  return (
    <div className={`card subscription-card status-${bill.review_status}`}>
      <div className="subscription-head">
        <div>
          <span className={`pill status-${bill.review_status}-pill`}>
            {STATUS_LABEL[bill.review_status]}
          </span>
          <span className="subscription-name">{bill.name}</span>
        </div>
        <span className="num neg">
          {formatCents(-bill.amount_cents)} / {bill.frequency}
        </span>
      </div>
      <div className="muted subscription-meta">
        Next due {formatDate(bill.next_due_date)}
        {monthlyLabel && <> · ≈ {monthlyLabel}/month</>}
        {bill.last_reviewed_at && (
          <> · last reviewed {formatDate(bill.last_reviewed_at.slice(0, 10))}</>
        )}
      </div>
      {bill.review_note && (
        <div className="subscription-note">“{bill.review_note}”</div>
      )}
      <div className="subscription-actions">
        <button
          className={`btn ${bill.review_status === 'cancel' ? '' : 'secondary'}`}
          type="button"
          onClick={() => onSetStatus('cancel')}
          title="Mark for cancellation — service isn't being used"
        >
          Cancel
        </button>
        <button
          className={`btn ${bill.review_status === 'alter' ? '' : 'secondary'}`}
          type="button"
          onClick={() => onSetStatus('alter')}
          title="Mark for downgrade / plan change"
        >
          Alter
        </button>
        <button
          className={`btn ${bill.review_status === 'keep' ? '' : 'secondary'}`}
          type="button"
          onClick={() => onSetStatus('keep')}
          title="Decision made — keep this subscription"
        >
          Keep
        </button>
        <button className="btn-link" type="button" onClick={onEditNote}>
          {bill.review_note ? 'Edit note' : 'Add note'}
        </button>
        <button
          className="btn-link"
          type="button"
          onClick={() => onSetStatus('active')}
          title="Clear the flag and return to the active list"
        >
          Clear flag
        </button>
      </div>
    </div>
  );
}

function NoteModal({
  bill,
  onClose,
  onSaved,
}: {
  bill: Bill;
  onClose: () => void;
  onSaved: (note: string | null) => void;
}) {
  const [text, setText] = useState(bill.review_note ?? '');
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Note · {bill.name}</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSaved(text.trim() === '' ? null : text.trim());
          }}
        >
          <div className="field">
            <label htmlFor="sub-note">Why is this flagged?</label>
            <textarea
              id="sub-note"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Downgrade to ad-supported tier; I never use 4K"
              autoFocus
            />
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn" type="submit">
              Save note
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
