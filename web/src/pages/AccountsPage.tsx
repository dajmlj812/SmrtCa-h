import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type Account, type CreateAccountInput } from '../api';
import { accountTypeLabel, formatCents } from '../format';

const ACCOUNT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'investment', label: 'Investment' },
  { value: 'loan', label: 'Loan' },
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

  const netWorth = accounts.reduce((sum, a) => sum + a.balance_cents, 0);

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

      {!loading && accounts.length > 0 && (
        <div className="stat-row">
          <div className="stat">
            <div className="stat-label">Net Worth</div>
            <div className="stat-value">{formatCents(netWorth)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Accounts</div>
            <div className="stat-value">{accounts.length}</div>
          </div>
        </div>
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
        <div className="card-grid">
          {accounts.map((a) => (
            <Link
              key={a.id}
              to={`/accounts/${a.id}`}
              className="card account-card"
            >
              <div className="acct-name">{a.name}</div>
              <div className="acct-meta">
                {a.institution ? `${a.institution} · ` : ''}
                {accountTypeLabel(a.type)}
                {a.last4 ? ` ····${a.last4}` : ''}
              </div>
              <div
                className={`acct-balance ${
                  a.balance_cents < 0 ? 'neg' : 'pos'
                }`}
              >
                {formatCents(a.balance_cents)}
              </div>
              <div className="acct-count">
                {a.transaction_count} transaction
                {a.transaction_count === 1 ? '' : 's'}
              </div>
            </Link>
          ))}
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
