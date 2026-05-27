import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type Account, type SavingsGoal } from '../api';
import { formatCents } from '../format';

/**
 * 0.22.2 — Credit-card payoff goal builder.
 *
 * Shared by /debt-payoff and /goals. The user picks which credit
 * card accounts to roll into the goal, then chooses between:
 *   • "Pay to $0" — full payoff, target balance is $0
 *   • "Pay to N% utilization" — target balance is (total_limit × N/100).
 *     30% is the conventional credit-score sweet spot, so it's the
 *     default. Requires every selected card to have credit_limit_cents
 *     set; the form blocks creation otherwise with a clear pointer.
 *
 * The goal stores:
 *   • initial_amount_cents — snapshot of total |balance| at create time
 *   • target_amount_cents  — the target balance the goal aims for
 *   • linked_account_ids   — the picked card ids (server uses them
 *                            to recompute current balance live)
 *   • target_utilization_pct — preserved so we can recompute target
 *                              if a card's limit changes later
 *
 * Display elsewhere (GoalCard) renders shrinking-direction progress:
 *   progress = (initial - current) / (initial - target)
 */

type TargetMode = 'zero' | 'utilization';

export function PayoffGoalModal({
  onClose,
  onCreated,
  preselectAccountIds,
}: {
  onClose: () => void;
  onCreated: (goal: SavingsGoal) => void;
  /** Optional starting selection (e.g. when launched from /debt-payoff). */
  preselectAccountIds?: string[];
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(preselectAccountIds ?? []),
  );
  const [mode, setMode] = useState<TargetMode>('utilization');
  const [pct, setPct] = useState('30');
  const [name, setName] = useState('');
  const [targetDate, setTargetDate] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load accounts + filter to credit cards.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await api.listAccounts();
        if (cancelled) return;
        setAccounts(all.filter((a) => a.type === 'credit_card'));
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : 'Failed to load accounts');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedAccts = useMemo(
    () => accounts.filter((a) => selected.has(a.id)),
    [accounts, selected],
  );

  /**
   * Total |balance| across selected cards. The accounts API returns
   * signed balances (negative for credit-card liability under the
   * 0.20.x sign convention), so abs() gets us amount-owed cents.
   */
  const totalBalance = useMemo(
    () => selectedAccts.reduce((sum, a) => sum + Math.abs(a.balance_cents), 0),
    [selectedAccts],
  );
  const totalLimit = useMemo(
    () =>
      selectedAccts.reduce(
        (sum, a) => sum + (a.credit_limit_cents ?? 0),
        0,
      ),
    [selectedAccts],
  );
  const missingLimits = useMemo(
    () => selectedAccts.filter((a) => !a.credit_limit_cents),
    [selectedAccts],
  );
  const currentUtilization = totalLimit > 0 ? totalBalance / totalLimit : 0;

  const pctNum = Number(pct);
  const targetBalance =
    mode === 'zero'
      ? 0
      : Math.round((totalLimit * (Number.isFinite(pctNum) ? pctNum : 0)) / 100);
  const paydown = Math.max(0, totalBalance - targetBalance);

  // Auto-name: only update when user hasn't typed a custom name yet.
  useEffect(() => {
    if (name.trim() !== '' && name !== autoNameOf(mode, pct, selectedAccts))
      return;
    setName(autoNameOf(mode, pct, selectedAccts));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pct, selectedAccts]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (selected.size === 0) {
      setError('Pick at least one credit card.');
      return;
    }
    if (totalBalance <= 0) {
      setError(
        'Selected cards have no outstanding balance — nothing to pay down.',
      );
      return;
    }
    if (mode === 'utilization') {
      if (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100) {
        setError('Utilization target must be between 0 and 100.');
        return;
      }
      if (missingLimits.length > 0) {
        setError(
          `Set a credit limit on these cards first (Accounts page): ${missingLimits
            .map((a) => a.name)
            .join(', ')}.`,
        );
        return;
      }
      if (totalBalance <= targetBalance) {
        setError(
          'Selected cards are already at or below the chosen utilization — nothing to pay down.',
        );
        return;
      }
    }

    setSubmitting(true);
    try {
      const goal = await api.createGoal({
        name: name.trim() || autoNameOf(mode, pct, selectedAccts),
        targetAmountCents: targetBalance,
        currentAmountCents: 0,
        targetDate: targetDate === '' ? null : targetDate,
        kind: 'payoff',
        initialAmountCents: totalBalance,
        linkedAccountIds: [...selected],
        targetUtilizationPct: mode === 'utilization' ? pctNum : null,
      });
      onCreated(goal);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <header className="modal-header">
          <h2>Credit-card payoff goal</h2>
          <button className="modal-close" type="button" onClick={onClose}>✕</button>
        </header>
        <form onSubmit={submit}>
          {(error || loadError) && (
            <div className="banner error">{error ?? loadError}</div>
          )}

          {loading ? (
            <p className="empty">Loading credit cards…</p>
          ) : accounts.length === 0 ? (
            <p className="empty">
              No credit card accounts on file. Add one on the Accounts page first.
            </p>
          ) : (
            <>
              <div className="field">
                <label>Include these cards</label>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    marginTop: 6,
                  }}
                >
                  {accounts.map((a) => (
                    <label
                      key={a.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        background: selected.has(a.id)
                          ? 'var(--accent-soft)'
                          : 'transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(a.id)}
                        onChange={() => toggle(a.id)}
                      />
                      <span style={{ flex: 1 }}>{a.name}</span>
                      <span className="muted small">
                        balance {formatCents(Math.abs(a.balance_cents))}
                      </span>
                      <span className="muted small">
                        {a.credit_limit_cents
                          ? `· limit ${formatCents(a.credit_limit_cents)}`
                          : '· no limit set'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {selected.size > 0 && (
                <div
                  className="card"
                  style={{
                    margin: '8px 0',
                    padding: 10,
                    background: 'var(--surface-3)',
                  }}
                >
                  <div className="muted small">Across {selected.size} card{selected.size === 1 ? '' : 's'}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                    <span>Total balance</span>
                    <strong>{formatCents(totalBalance)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Total credit limit</span>
                    <strong>
                      {totalLimit > 0 ? formatCents(totalLimit) : '—'}
                    </strong>
                  </div>
                  {totalLimit > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Current utilization</span>
                      <strong>{Math.round(currentUtilization * 100)}%</strong>
                    </div>
                  )}
                </div>
              )}

              <div className="field">
                <label htmlFor="payoff-mode">Payoff target</label>
                <select
                  id="payoff-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as TargetMode)}
                >
                  <option value="utilization">
                    Pay to a target utilization % (best for credit score)
                  </option>
                  <option value="zero">Pay off completely ($0 balance)</option>
                </select>
                <div className="muted small" style={{ marginTop: 4 }}>
                  Keeping utilization at or below 30% across your cards is the
                  standard credit-score recommendation. Below 10% is even
                  better.
                </div>
              </div>

              {mode === 'utilization' && (
                <div className="field">
                  <label htmlFor="payoff-pct">Target utilization %</label>
                  <input
                    id="payoff-pct"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={pct}
                    onChange={(e) => setPct(e.target.value)}
                    required
                  />
                  {missingLimits.length > 0 && (
                    <div className="banner warning" style={{ marginTop: 6 }}>
                      Set a credit limit on: {missingLimits.map((a) => a.name).join(', ')}.
                      Until then the utilization target can't be computed.
                    </div>
                  )}
                </div>
              )}

              {selected.size > 0 && totalBalance > 0 && (
                <div
                  className="card"
                  style={{
                    margin: '8px 0',
                    padding: 10,
                    background: 'var(--accent-soft)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Target balance</span>
                    <strong>{formatCents(targetBalance)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Amount to pay down</span>
                    <strong className="pos">{formatCents(paydown)}</strong>
                  </div>
                </div>
              )}

              <div className="form-grid">
                <div className="field">
                  <label htmlFor="payoff-name">Goal name</label>
                  <input
                    id="payoff-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="payoff-date">Target date (optional)</label>
                  <input
                    id="payoff-date"
                    type="date"
                    value={targetDate}
                    onChange={(e) => setTargetDate(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 16,
            }}
          >
            <button type="button" className="btn secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn"
              disabled={submitting || loading || accounts.length === 0}
            >
              {submitting ? 'Creating…' : 'Create payoff goal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function autoNameOf(
  mode: TargetMode,
  pct: string,
  selected: Account[],
): string {
  if (selected.length === 0) return '';
  if (mode === 'zero') return 'Pay off credit cards';
  const p = Number(pct);
  if (!Number.isFinite(p)) return 'Pay down credit cards';
  return `Pay credit cards down to ${Math.round(p)}% utilization`;
}
