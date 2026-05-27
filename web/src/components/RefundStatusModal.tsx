import { useState, type FormEvent } from 'react';
import {
  api,
  REFUND_STATUS_LABELS,
  type RefundStatus,
  type Transaction,
} from '../api';
import { formatCents, formatDate } from '../format';

/**
 * 0.21.1 — Refund / chargeback lifecycle modal.
 *
 * Lets the user mark a single transaction as refund_pending →
 * refunded | disputed | chargeback_initiated → closed, with an
 * optional free-text note. "Clear status" reverts back to NULL
 * (the row leaves the open-refunds filter).
 */

const STATUSES: RefundStatus[] = [
  'refund_pending',
  'refunded',
  'chargeback_initiated',
  'disputed',
  'closed',
];

interface Props {
  transaction: Transaction;
  onClose: () => void;
  onSaved: (updated: Transaction) => void;
}

export function RefundStatusModal({ transaction, onClose, onSaved }: Props) {
  const [status, setStatus] = useState<RefundStatus | ''>(
    transaction.refund_status ?? '',
  );
  const [note, setNote] = useState(transaction.refund_note ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const updated = await api.updateTransaction(transaction.id, {
        refundStatus: status === '' ? null : status,
        refundNote: status === '' ? null : note.trim() || null,
      });
      onSaved(updated);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={submit} style={{ maxWidth: 480 }}>
        <h2>Track refund / chargeback</h2>
        <div className="muted" style={{ marginBottom: 12 }}>
          <strong>{transaction.normalized_merchant ?? transaction.raw_description}</strong>
          {' · '}
          {formatCents(transaction.amount_cents)}
          {' · '}
          {formatDate(transaction.txn_date)}
        </div>
        {error && <div className="banner error">{error}</div>}
        <div className="field">
          <label htmlFor="refund-status">Status</label>
          <select
            id="refund-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as RefundStatus | '')}
          >
            <option value="">— Clear / no refund —</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{REFUND_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="refund-note">Note (optional)</label>
          <textarea
            id="refund-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={status === ''}
            placeholder="e.g. Filed chargeback on 2026-05-15, awaiting Visa response"
          />
        </div>
        {transaction.refund_updated_at && (
          <p className="muted small">
            Last updated{' '}
            {new Date(transaction.refund_updated_at).toLocaleString()}
          </p>
        )}
        <div className="modal-footer">
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
