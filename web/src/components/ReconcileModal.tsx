import { useEffect, useMemo, useState } from 'react';
import { api, type Transaction } from '../api';
import { formatCents, formatDate } from '../format';

interface Props {
  accountId: string;
  accountName: string;
  /** Called with the result when the reconcile commits successfully. */
  onCommitted: (reconciled: number, statementDate: string) => void;
  onClose: () => void;
}

/**
 * 0.19.2 — Banktivity-style reconciliation workflow.
 *
 * Flow:
 *   1. User enters the statement closing balance + statement date.
 *   2. We load every uncleared transaction in the account whose
 *      txn_date <= statement date, plus the cleared-balance summary.
 *   3. User ticks the checkboxes against the statement.
 *   4. Running difference = statement_closing_balance - (cleared_balance
 *      + selected_uncleared_sum). When it hits zero, the Commit button
 *      activates and the user can press it to set cleared_at on all
 *      ticked rows in one bulk call.
 *
 * Why a fresh load (vs. trusting the page's transactions list):
 * the parent page may have filters, pagination, or stale data. The
 * reconcile workflow needs the canonical uncleared set scoped to
 * the statement window, so we hit /api/transactions ourselves with
 * the right filters.
 */
export function ReconcileModal({
  accountId,
  accountName,
  onCommitted,
  onClose,
}: Props) {
  const [statementDate, setStatementDate] = useState<string>(
    new Date().toISOString().slice(0, 10),
  );
  const [statementBalanceStr, setStatementBalanceStr] = useState('');
  const [step, setStep] = useState<'setup' | 'reconcile'>('setup');

  const [uncleared, setUncleared] = useState<Transaction[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [clearedBalance, setClearedBalance] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  const statementBalanceCents = useMemo(() => {
    const n = Number(statementBalanceStr);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }, [statementBalanceStr]);

  const selectedSum = useMemo(
    () =>
      uncleared
        .filter((t) => checkedIds.has(t.id))
        .reduce((sum, t) => sum + t.amount_cents, 0),
    [uncleared, checkedIds],
  );

  const difference =
    statementBalanceCents === null
      ? null
      : statementBalanceCents - (clearedBalance + selectedSum);

  const canCommit =
    statementBalanceCents !== null &&
    difference === 0 &&
    checkedIds.size > 0;

  async function startReconcile() {
    if (statementBalanceCents === null) {
      setError('Enter a closing balance to continue');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Pull the cleared-balance summary AS OF the statement date.
      // This is the right baseline — anything cleared after the
      // statement date shouldn't count against this reconcile.
      const summary = await api.getClearedBalance(accountId, statementDate);
      setClearedBalance(summary.cleared_balance_cents);

      // Pull every uncleared transaction in the account through the
      // statement date. The endpoint paginates at 500 — for accounts
      // with more than 500 uncleared rows this will need a multi-page
      // fetch, but that's an unusual case (and a sign the user has
      // been deferring reconciles for a long time).
      const page = await api.listTransactions({
        accountId,
        limit: 500,
        endDate: statementDate,
      });
      const u = page.transactions.filter((t) => t.cleared_at === null);
      setUncleared(u);
      setCheckedIds(new Set());
      setStep('reconcile');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load uncleared transactions');
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (checkedIds.size === uncleared.length) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(uncleared.map((t) => t.id)));
    }
  }

  async function commit() {
    setCommitting(true);
    setError(null);
    try {
      const result = await api.reconcileAccount(accountId, {
        statementDate,
        transactionIds: Array.from(checkedIds),
      });
      onCommitted(result.reconciled, result.statementDate);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reconcile commit failed');
      setCommitting(false);
    }
  }

  // Reset error when the user changes inputs mid-flow.
  useEffect(() => {
    if (error) setError(null);
  }, [statementDate, statementBalanceStr, checkedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="modal modal-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Reconcile — {accountName}</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>

        {error && <div className="banner error">{error}</div>}

        {step === 'setup' && (
          <div className="modal-body">
            <p className="muted">
              Match your books to a bank statement. Enter the statement's
              closing balance and date — we'll show every uncleared
              transaction through that date so you can tick them off.
            </p>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="statement-date">Statement date</label>
                <input
                  id="statement-date"
                  type="date"
                  value={statementDate}
                  onChange={(e) => setStatementDate(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="statement-balance">Statement closing balance</label>
                <input
                  id="statement-balance"
                  type="number"
                  step="0.01"
                  value={statementBalanceStr}
                  onChange={(e) => setStatementBalanceStr(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
            <footer className="modal-footer">
              <button type="button" className="btn secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                disabled={loading || statementBalanceCents === null}
                onClick={() => void startReconcile()}
              >
                {loading ? 'Loading…' : 'Start reconcile'}
              </button>
            </footer>
          </div>
        )}

        {step === 'reconcile' && (
          <div className="modal-body reconcile-body">
            <div className="reconcile-summary">
              <div className="reconcile-summary-row">
                <span className="muted">Statement balance</span>
                <strong>{formatCents(statementBalanceCents!)}</strong>
              </div>
              <div className="reconcile-summary-row">
                <span className="muted">Cleared as of {statementDate}</span>
                <strong>{formatCents(clearedBalance)}</strong>
              </div>
              <div className="reconcile-summary-row">
                <span className="muted">Selected uncleared ({checkedIds.size})</span>
                <strong>{formatCents(selectedSum)}</strong>
              </div>
              <div className={`reconcile-summary-row reconcile-diff ${difference === 0 ? 'is-zero' : ''}`}>
                <span>Difference</span>
                <strong>{difference !== null ? formatCents(difference) : '—'}</strong>
              </div>
            </div>

            {uncleared.length === 0 ? (
              <p className="empty">
                No uncleared transactions through {statementDate}. Either everything
                is already cleared, or there's nothing to reconcile in this window.
              </p>
            ) : (
              <div className="table-wrap reconcile-table-wrap">
                <table className="txn-table">
                  <thead>
                    <tr>
                      <th className="check-col">
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          checked={checkedIds.size === uncleared.length}
                          onChange={toggleAll}
                        />
                      </th>
                      <th>Date</th>
                      <th>Description</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uncleared.map((t) => (
                      <tr key={t.id} className={checkedIds.has(t.id) ? 'selected' : ''}>
                        <td className="check-col">
                          <input
                            type="checkbox"
                            checked={checkedIds.has(t.id)}
                            onChange={() => toggle(t.id)}
                          />
                        </td>
                        <td className="nowrap">{formatDate(t.txn_date)}</td>
                        <td>{t.normalized_merchant ?? t.raw_description}</td>
                        <td className={`num ${t.amount_cents < 0 ? 'neg' : 'pos'}`}>
                          {formatCents(t.amount_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <footer className="modal-footer">
              <button
                type="button"
                className="btn secondary"
                onClick={() => setStep('setup')}
              >
                Back
              </button>
              <button
                type="button"
                className="btn"
                disabled={!canCommit || committing}
                onClick={() => void commit()}
                title={
                  canCommit
                    ? `Commit will mark ${checkedIds.size} transactions as cleared`
                    : 'Difference must be zero and at least one transaction selected'
                }
              >
                {committing
                  ? 'Committing…'
                  : `Commit (${checkedIds.size} cleared)`}
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
