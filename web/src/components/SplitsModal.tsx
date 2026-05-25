import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type Category,
  type Transaction,
  type TransactionSplit,
} from '../api';
import { formatCents, formatDate } from '../format';
import { AttachmentPreviewPane } from './AttachmentPreviewPane';

interface Props {
  transaction: Transaction;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}

interface SplitDraft {
  /** Local React key — not persisted. */
  key: string;
  categoryId: string | null;
  /** Stored in cents so the running total math stays exact. */
  amountCents: number;
  memo: string;
}

let nextKey = 1;
function newKey(): string {
  return `s${nextKey++}`;
}

function toDollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function parseDollars(input: string, txnIsNegative: boolean): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n === 0) return 0;
  // The user types positive numbers; we apply the transaction's sign so
  // splits naturally inherit it (a $-100 transaction's splits are all
  // negative). If the user types a negative number, we honor it.
  if (input.trim().startsWith('-')) return Math.round(n * 100);
  return Math.round(n * 100) * (txnIsNegative ? -1 : 1);
}

export function SplitsModal({ transaction, categories, onClose, onSaved }: Props) {
  const txnAmount = transaction.amount_cents;
  const txnIsNegative = txnAmount < 0;

  const [splits, setSplits] = useState<SplitDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const existing = await api.listSplits(transaction.id);
        if (existing.length > 0) {
          setSplits(
            existing.map((s: TransactionSplit) => ({
              key: newKey(),
              categoryId: s.category_id,
              amountCents: s.amount_cents,
              memo: s.memo ?? '',
            })),
          );
        } else {
          // Seed with two empty rows — one with the full amount, one blank
          // ready for the user to enter.
          setSplits([
            {
              key: newKey(),
              categoryId: transaction.category_id,
              amountCents: txnAmount,
              memo: '',
            },
            { key: newKey(), categoryId: null, amountCents: 0, memo: '' },
          ]);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load splits');
      } finally {
        setLoading(false);
      }
    })();
  }, [transaction.id, transaction.category_id, txnAmount]);

  const total = splits.reduce((acc, s) => acc + s.amountCents, 0);
  const remaining = txnAmount - total;

  function updateSplit(key: string, patch: Partial<SplitDraft>) {
    setSplits((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }
  function removeSplit(key: string) {
    setSplits((prev) => prev.filter((s) => s.key !== key));
  }
  function addSplit() {
    setSplits((prev) => [
      ...prev,
      { key: newKey(), categoryId: null, amountCents: 0, memo: '' },
    ]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const filtered = splits.filter((s) => s.amountCents !== 0);
    if (filtered.length === 0) {
      // User wants to clear splits entirely.
      setSubmitting(true);
      try {
        await api.saveSplits(transaction.id, []);
        onSaved();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to clear splits');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const sum = filtered.reduce((acc, s) => acc + s.amountCents, 0);
    if (sum !== txnAmount) {
      setError(
        `Splits sum to ${formatCents(sum)} but the transaction is ${formatCents(txnAmount)} (${formatCents(remaining)} remaining)`,
      );
      return;
    }
    setSubmitting(true);
    try {
      await api.saveSplits(
        transaction.id,
        filtered.map((s) => ({
          categoryId: s.categoryId,
          amountCents: s.amountCents,
          memo: s.memo.trim() === '' ? undefined : s.memo,
        })),
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function clearAll() {
    if (!window.confirm('Remove all splits on this transaction?')) return;
    setSubmitting(true);
    try {
      await api.saveSplits(transaction.id, []);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clear failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal modal-wide split-modal-shell" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>Split transaction</h2>
            <div className="modal-subtitle">
              {transaction.normalized_merchant ?? transaction.raw_description} ·{' '}
              {formatDate(transaction.txn_date)} ·{' '}
              <span className={`num ${txnIsNegative ? 'neg' : 'pos'}`}>
                {formatCents(txnAmount)}
              </span>
            </div>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        {error && <div className="banner error">{error}</div>}
        <div className="split-modal-body">
          {/* 0.18.13 — Attachment preview alongside the split editor.
              Returns null when the transaction has no attachments so
              the layout collapses to single-column on its own. */}
          <AttachmentPreviewPane
            transactionId={transaction.id}
            className="split-modal-preview"
          />
          <div className="split-modal-editor">
        {loading ? (
          <p className="empty">Loading…</p>
        ) : (
          <form onSubmit={submit}>
            <div className="split-rows">
              {splits.map((s) => (
                <div key={s.key} className="split-row">
                  <select
                    className="cell-select"
                    value={s.categoryId ?? ''}
                    onChange={(e) =>
                      updateSplit(s.key, {
                        categoryId: e.target.value === '' ? null : e.target.value,
                      })
                    }
                  >
                    <option value="">— Uncategorized —</option>
                    {categories
                      .filter((c) => c.parent_id !== null)
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    className="split-amount"
                    value={
                      s.amountCents === 0 ? '' : toDollars(Math.abs(s.amountCents))
                    }
                    onChange={(e) =>
                      updateSplit(s.key, {
                        amountCents: parseDollars(e.target.value, txnIsNegative),
                      })
                    }
                  />
                  <input
                    type="text"
                    placeholder="Memo (optional)"
                    className="split-memo"
                    value={s.memo}
                    onChange={(e) => updateSplit(s.key, { memo: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn-link danger"
                    onClick={() => removeSplit(s.key)}
                    title="Remove this split"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="split-footer">
              <button type="button" className="btn secondary small" onClick={addSplit}>
                + Add line
              </button>
              <span className="muted split-total">
                Sum {formatCents(total)} ·{' '}
                <strong className={remaining === 0 ? 'pos' : 'neg'}>
                  {formatCents(remaining)} remaining
                </strong>
              </span>
            </div>
            <div className="split-actions">
              <button
                type="submit"
                className="btn"
                disabled={submitting || (remaining !== 0 && splits.some((s) => s.amountCents !== 0))}
              >
                {submitting ? 'Saving…' : 'Save splits'}
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => void clearAll()}
                disabled={submitting}
              >
                Clear splits
              </button>
              <button type="button" className="btn secondary" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
          </div>
        </div>
      </div>
    </div>
  );
}
