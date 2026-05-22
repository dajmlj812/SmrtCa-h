import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Account, type Category, type Transaction } from '../api';
import { accountTypeLabel, formatCents } from '../format';
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
      <Link to="/" className="back-link">
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
                <div className="kv-label">Transactions</div>
                <div className="kv-value">{account.transaction_count}</div>
              </div>
            </div>
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
