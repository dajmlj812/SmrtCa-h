import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type Account, type CreateAccountInput } from '../api';
import { accountTypeLabel, formatCents } from '../format';

/** Account types whose balance represents money owed, not money you have. */
const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'manual_liability']);

const ACCOUNT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'investment', label: 'Investment' },
  { value: 'loan', label: 'Loan' },
  { value: 'manual_asset', label: 'Asset (manual, e.g. house)' },
  { value: 'manual_liability', label: 'Liability (manual, e.g. mortgage)' },
  { value: 'other', label: 'Other' },
];

export function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setAccounts(await api.listAccounts());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Accounts</h1>
          <div className="subtitle">Your bank and credit-card accounts</div>
        </div>
        <button className="btn" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New Account'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {showForm && (
        <NewAccountForm
          onCreated={() => {
            setShowForm(false);
            void load();
          }}
        />
      )}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : accounts.length === 0 ? (
        <div className="card">
          <p className="muted">
            No accounts yet. Create one above, then{' '}
            <Link to="/import">import a statement</Link>.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Institution</th>
                <th>Type</th>
                <th className="num">Balance</th>
                <th className="num">Transactions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const isLiability = LIABILITY_TYPES.has(a.type);
                // Liability balances are debt: always shown as a
                // negative number in red, regardless of sign convention
                // in the underlying row.
                const displayCents = isLiability
                  ? -Math.abs(a.balance_cents)
                  : a.balance_cents;
                return (
                  <tr key={a.id} className="account-row">
                    <td>
                      <Link to={`/accounts/${a.id}`} className="account-link">
                        <strong>{a.name}</strong>
                        {a.last4 && (
                          <span className="muted small" style={{ marginLeft: 8 }}>
                            ····{a.last4}
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="muted">{a.institution ?? '—'}</td>
                    <td>{accountTypeLabel(a.type)}</td>
                    <td className={`num ${displayCents < 0 ? 'neg' : 'pos'}`}>
                      {formatCents(displayCents)}
                    </td>
                    <td className="num muted">{a.transaction_count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewAccountForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [institution, setInstitution] = useState('');
  const [type, setType] = useState('checking');
  const [last4, setLast4] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const input: CreateAccountInput = {
        name: name.trim(),
        type,
        institution: institution.trim() || undefined,
        last4: last4.trim() || undefined,
      };
      await api.createAccount(input);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card" style={{ marginBottom: 24 }} onSubmit={submit}>
      <div className="section-title" style={{ marginTop: 0 }}>
        New account
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="account-name">Name *</label>
          <input
            id="account-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Chase Checking"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="account-institution">Institution</label>
          <input
            id="account-institution"
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            placeholder="Chase"
          />
        </div>
        <div className="field">
          <label htmlFor="account-type">Type</label>
          <select
            id="account-type"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {ACCOUNT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="account-last4">Last 4 digits</label>
          <input
            id="account-last4"
            value={last4}
            onChange={(e) => setLast4(e.target.value)}
            placeholder="0444"
            maxLength={4}
          />
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <button
          className="btn"
          type="submit"
          disabled={submitting || !name.trim()}
        >
          {submitting ? 'Creating…' : 'Create Account'}
        </button>
      </div>
    </form>
  );
}
