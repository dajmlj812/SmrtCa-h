import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Account, type Category, type Transaction } from '../api';
import { accountTypeLabel, formatCents, formatDate } from '../format';
import { TransactionTable } from '../components/TransactionTable';
import { AttachmentsModal } from '../components/AttachmentsModal';
import { HoldingsPanel } from '../components/HoldingsPanel';
import { ReconcileModal } from '../components/ReconcileModal';

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
  const [showReconcile, setShowReconcile] = useState(false);

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
    updates: { categoryId?: string | null; clearedAt?: string | null },
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
                cleared_at: updated.cleared_at,
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
            <div className="page-header-actions">
              <button
                className="btn secondary"
                onClick={() => setShowReconcile(true)}
                title="Match this account to a bank statement"
              >
                Reconcile
              </button>
              <button className="btn danger" onClick={remove}>
                Delete
              </button>
            </div>
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

      {account?.type === 'investment' && (
        <HoldingsPanel
          accountId={account.id}
          onChanged={() => void load(search)}
        />
      )}

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

      {showReconcile && account && (
        <ReconcileModal
          accountId={account.id}
          accountName={account.name}
          onClose={() => setShowReconcile(false)}
          onCommitted={(reconciled) => {
            setShowReconcile(false);
            // Re-fetch so the cleared checkboxes and balances reflect
            // the bulk commit. Cheap enough; the alternative would be
            // to surgically patch state which gets tricky when the
            // committed set might exceed what's currently visible.
            void load(search);
            // Surface confirmation via the existing error/banner slot.
            // Note: a non-error banner would be cleaner; reusing the
            // error state for the message is the pragmatic option
            // until we add a generic toast.
            setError(`Reconciled ${reconciled} transactions.`);
            setTimeout(() => setError(null), 4000);
          }}
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
  // Liability accounts store the value as a negative cents number but the
  // user thinks in "amount owed" — a positive figure. Translate at the
  // input/display layer so the SQL stays sign-coherent (sum() across all
  // accounts = net worth).
  const isLiability = account.type === 'manual_liability';
  const initial = isLiability
    ? -account.opening_balance_cents
    : account.opening_balance_cents;
  const [dollars, setDollars] = useState((initial / 100).toFixed(2));
  const [date, setDate] = useState(account.opening_balance_date ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const userCents = Math.round(Number(dollars) * 100);
      if (!Number.isFinite(userCents)) {
        throw new Error('Amount must be a number');
      }
      const storedCents = isLiability ? -Math.abs(userCents) : userCents;
      const saved = await api.updateAccount(account.id, {
        opening_balance_cents: storedCents,
        opening_balance_date: date === '' ? null : date,
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const label = isLiability
    ? 'Amount owed ($)'
    : account.type === 'manual_asset'
      ? 'Current value ($)'
      : 'Opening balance ($)';

  return (
    <form className="opening-balance-form" onSubmit={submit}>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="opening-balance">{label}</label>
          <input
            id="opening-balance"
            type="number"
            step="0.01"
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
          />
        </div>
        {account.type !== 'manual_asset' && account.type !== 'manual_liability' && (
          <div className="field">
            <label htmlFor="opening-date">As of (optional)</label>
            <input
              id="opening-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        )}
      </div>
      {(account.type === 'manual_asset' || account.type === 'manual_liability') ? (
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Update this whenever the value changes (a new appraisal, a loan
          payment). The figure flows into your net worth without needing
          transaction-level detail.
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Leave the date blank to apply the opening balance against all imported
          transactions. Set a date if your imports go back further than the
          statement balance you know.
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
