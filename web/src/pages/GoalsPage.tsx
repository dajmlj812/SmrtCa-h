import { useEffect, useState, type FormEvent } from 'react';
import { api, type Account, type SavingsGoal } from '../api';
import { formatCents, formatDate } from '../format';

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export function GoalsPage() {
  const [goals, setGoals] = useState<SavingsGoal[]>([]);
  // 0.17.21
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SavingsGoal | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [g, a] = await Promise.all([api.listGoals(), api.listAccounts()]);
      setGoals(g);
      setAccounts(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load goals');
    } finally {
      setLoading(false);
    }
  }

  async function setGoalAccount(id: string, accountId: string | null) {
    try {
      await api.updateGoal(id, { accountId });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Account update failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function onDelete(id: string) {
    if (!window.confirm('Delete this goal?')) return;
    try {
      await api.deleteGoal(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Savings goals</h1>
          <div className="subtitle">
            Track progress toward named targets. Adjust the current amount
            manually as you move money in.
          </div>
        </div>
        <button className="btn" onClick={() => setShowCreate(true)}>
          New goal
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : goals.length === 0 && !showCreate ? (
        <div className="card">
          <p className="muted">
            No goals yet. Create your first one with the <strong>New
            goal</strong> button above — name it (e.g. "Emergency fund"), set a
            target, and optionally pick a date.
          </p>
        </div>
      ) : (
        <div className="goal-grid">
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              accounts={accounts}
              onEdit={() => setEditing(g)}
              onDelete={() => void onDelete(g.id)}
              onSetAccount={(aId) => void setGoalAccount(g.id, aId)}
            />
          ))}
        </div>
      )}

      {(showCreate || editing) && (
        <GoalForm
          goal={editing ?? undefined}
          accounts={accounts}
          onClose={() => {
            setShowCreate(false);
            setEditing(null);
          }}
          onSaved={() => {
            setShowCreate(false);
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function GoalCard({
  goal,
  accounts,
  onEdit,
  onDelete,
  onSetAccount,
}: {
  goal: SavingsGoal;
  accounts: Account[];
  onEdit: () => void;
  onDelete: () => void;
  onSetAccount: (accountId: string | null) => void;
}) {
  const pct = Math.round(Number(goal.progress) * 100);
  const remaining = Math.max(0, goal.target_amount_cents - goal.current_amount_cents);
  let dateNote: string | null = null;
  if (goal.target_date) {
    const d = daysUntil(goal.target_date);
    dateNote =
      d > 0
        ? `${d} day${d === 1 ? '' : 's'} to go — ${formatDate(goal.target_date)}`
        : d === 0
          ? 'Due today'
          : `${-d} day${d === -1 ? '' : 's'} past — ${formatDate(goal.target_date)}`;
  }
  return (
    <div className="card goal-card">
      <div className="goal-card-head">
        <div>
          <div className="goal-card-name">{goal.name}</div>
          {dateNote && <div className="muted goal-card-date">{dateNote}</div>}
        </div>
        <div className="goal-card-actions">
          <button className="btn-link" type="button" onClick={onEdit}>
            Edit
          </button>
          <button className="btn-link danger" type="button" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
      <div className="goal-card-amount">
        <strong>{formatCents(goal.current_amount_cents)}</strong>
        <span className="muted"> / {formatCents(goal.target_amount_cents)}</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="muted goal-card-foot">
        {pct}% complete · {formatCents(remaining)} remaining
      </div>
      <div style={{ marginTop: 8 }}>
        <label className="muted small" style={{ display: 'block', marginBottom: 2 }}>
          Funded from
        </label>
        <select
          value={goal.account_id ?? ''}
          onChange={(e) =>
            onSetAccount(e.target.value === '' ? null : e.target.value)
          }
          style={{ fontSize: '0.9em', width: '100%' }}
          title="Account this goal is funded from; controls which plan's savings suggestion includes it"
        >
          <option value="">— No account —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function GoalForm({
  goal,
  accounts,
  onClose,
  onSaved,
}: {
  goal?: SavingsGoal;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!goal;
  const [name, setName] = useState(goal?.name ?? '');
  const [targetDollars, setTargetDollars] = useState(
    goal ? (goal.target_amount_cents / 100).toFixed(2) : '',
  );
  const [currentDollars, setCurrentDollars] = useState(
    goal ? (goal.current_amount_cents / 100).toFixed(2) : '0.00',
  );
  const [targetDate, setTargetDate] = useState(goal?.target_date ?? '');
  // 0.17.21
  const [accountId, setAccountId] = useState<string>(goal?.account_id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const targetCents = Math.round(Number(targetDollars) * 100);
      const currentCents = Math.round(Number(currentDollars) * 100);
      if (!Number.isFinite(targetCents) || targetCents <= 0) {
        throw new Error('Target must be > 0');
      }
      if (!Number.isFinite(currentCents) || currentCents < 0) {
        throw new Error('Current must be ≥ 0');
      }
      const dateVal = targetDate === '' ? null : targetDate;
      const acctVal = accountId === '' ? null : accountId;
      if (isEdit) {
        await api.updateGoal(goal!.id, {
          name,
          targetAmountCents: targetCents,
          currentAmountCents: currentCents,
          targetDate: dateVal,
          accountId: acctVal,
        });
      } else {
        await api.createGoal({
          name,
          targetAmountCents: targetCents,
          currentAmountCents: currentCents,
          targetDate: dateVal,
          accountId: acctVal,
        });
      }
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
          <h2>{isEdit ? 'Edit goal' : 'New goal'}</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form onSubmit={submit}>
          {error && <div className="banner error">{error}</div>}
          <div className="field">
            <label htmlFor="goal-name">Name</label>
            <input
              id="goal-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="goal-target">Target ($)</label>
              <input
                id="goal-target"
                type="number"
                step="0.01"
                min="0.01"
                value={targetDollars}
                onChange={(e) => setTargetDollars(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="goal-current">Current ($)</label>
              <input
                id="goal-current"
                type="number"
                step="0.01"
                min="0"
                value={currentDollars}
                onChange={(e) => setCurrentDollars(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="goal-date">Target date (optional)</label>
              <input
                id="goal-date"
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
              />
            </div>
            {/* 0.17.21 — funded-from account */}
            <div className="field">
              <label htmlFor="goal-acct">Funded from (optional)</label>
              <select
                id="goal-acct"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">— No account —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save' : 'Create goal'}
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
