import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Account, type Category, type Transaction } from '../api';
import { accountTypeLabel, formatCents, formatDate } from '../format';
import { TransactionTable } from '../components/TransactionTable';
import { AttachmentsModal } from '../components/AttachmentsModal';

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [account, setAccount] = useState<Account | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attachmentsFor, setAttachmentsFor] = useState<Transaction | null>(
    null,
  );
  const [editingBalance, setEditingBalance] = useState(false);

  async function load(searchTerm: string) {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [acct, page, cats] = await Promise.all([
        api.getAccount(id),
        api.listTransactions({
          accountId: id,
          search: searchTerm || undefined,
          limit: 200,
        }),
        api.listCategories(),
      ]);
      setAccount(acct);
      setTransactions(page.transactions);
      setTotal(page.total);
      setCategories(cats);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load account');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load('');
  }, [id]);

  async function remove() {
    if (!id || !account) return;
    if (!window.confirm(`Delete "${account.name}" and all its transactions?`)) {
      return;
    }
    try {
      await api.deleteAccount(id);
      navigate('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete account');
    }
  }

  async function onTxnUpdate(
    txnId: string,
    updates: { categoryId: string | null },
  ) {
    try {
      const updated = await api.updateTransaction(txnId, updates);
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === txnId
            ? {
                ...t,
                category_id: updated.category_id,
                category_name:
                  categories.find((c) => c.id === updated.category_id)?.name ??
                  null,
                normalization_status: updated.normalization_status,
              }
            : t,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update transaction');
    }
  }

  return (
    <div>
      <Link to="/accounts" className="back-link">
        ← Accounts
      </Link>
      {error && <div className="banner error">{error}</div>}

      {account && (
        <>
          <div className="page-header">
            <div>
              <h1>{account.name}</h1>
              <div className="subtitle">
                {account.institution ? `${account.institution} · ` : ''}
                {accountTypeLabel(account.type)}
                {account.last4 ? ` ····${account.last4}` : ''}
              </div>
            </div>
            <button className="btn danger" onClick={remove}>
              Delete
            </button>
          </div>

          <div className="card" style={{ marginBottom: 24 }}>
            <div className="kv">
              <div className="kv-item">
                <div className="kv-label">Balance</div>
                <div
                  className={`kv-value ${
                    account.balance_cents < 0 ? 'neg' : 'pos'
                  }`}
                >
                  {formatCents(account.balance_cents)}
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Opening</div>
                <div className="kv-value">
                  {formatCents(account.opening_balance_cents)}
                  {account.opening_balance_date && (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      as of {formatDate(account.opening_balance_date)}
                    </span>
                  )}
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Transactions</div>
                <div className="kv-value">{account.transaction_count}</div>
              </div>
              <div className="kv-item" style={{ alignSelf: 'center' }}>
                <button
                  className="btn secondary"
                  onClick={() => setEditingBalance((v) => !v)}
                >
                  {editingBalance ? 'Cancel' : 'Edit opening balance'}
                </button>
              </div>
            </div>
            {editingBalance && (
              <OpeningBalanceForm
                account={account}
                onSaved={(saved) => {
                  setAccount(saved);
                  setEditingBalance(false);
                  void load(search);
                }}
              />
            )}
          </div>
        </>
      )}

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search descriptions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(search);
          }}
        />
        <button className="btn secondary" onClick={() => void load(search)}>
          Search
        </button>
        <div className="spacer" />
        <span className="muted">{total} total</span>
      </div>

      {loading ? (
        <p className="empty">Loading…</p>
      ) : (
        <TransactionTable
          transactions={transactions}
          categories={categories}
          showRunningBalance
          onUpdate={onTxnUpdate}
          onOpenAttachments={setAttachmentsFor}
        />
      )}

      {attachmentsFor && (
        <AttachmentsModal
          transaction={attachmentsFor}
          onClose={() => setAttachmentsFor(null)}
          onCountChange={(count) =>
            setTransactions((prev) =>
              prev.map((t) =>
                t.id === attachmentsFor.id
                  ? { ...t, attachment_count: count }
                  : t,
              ),
            )
          }
        />
      )}
    </div>
  );
}

function OpeningBalanceForm({
  account,
  onSaved,
}: {
  account: Account;
  onSaved: (saved: Account) => void;
}) {
  const [dollars, setDollars] = useState(
    (account.opening_balance_cents / 100).toFixed(2),
  );
  const [date, setDate] = useState(account.opening_balance_date ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const cents = Math.round(Number(dollars) * 100);
      if (!Number.isFinite(cents)) {
        throw new Error('Opening balance must be a number');
      }
      const saved = await api.updateAccount(account.id, {
        opening_balance_cents: cents,
        opening_balance_date: date === '' ? null : date,
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="opening-balance-form" onSubmit={submit}>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="opening-balance">Opening balance ($)</label>
          <input
            id="opening-balance"
            type="number"
            step="0.01"
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="opening-date">As of (optional)</label>
          <input
            id="opening-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
        Leave the date blank to apply the opening balance against all imported
        transactions. Set a date if your imports go back further than the
        statement balance you know.
      </div>
      <div style={{ marginTop: 12 }}>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save opening balance'}
        </button>
      </div>
    </form>
  );
}
