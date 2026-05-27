import { useEffect, useState } from 'react';
import { api, type Account, type Category, type Transaction } from '../api';
import { TransactionTable, type SortKey } from '../components/TransactionTable';
import { BulkActionBar } from '../components/BulkActionBar';
import { SplitsModal } from '../components/SplitsModal';

const PAGE_SIZE = 100;

/**
 * 0.21.x — Triage queue.
 *
 * Two filters to make bulk-categorisation faster:
 *   • Multi-account chips — narrow the page to one or more
 *     accounts so similar transactions cluster together.
 *   • Sortable columns — click a header to group same-merchant
 *     or same-amount rows, then bulk-categorise.
 */
export function UncategorizedPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [splittingFor, setSplittingFor] = useState<Transaction | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    api.listCategories().then(setCategories).catch(() => undefined);
    api.listAccounts().then(setAccounts).catch(() => undefined);
  }, []);

  async function load(nextOffset: number) {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listTransactions({
        limit: PAGE_SIZE,
        offset: nextOffset,
        uncategorized: true,
        accountIds: selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
      });
      setTransactions(page.transactions);
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transactions');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, selectedAccountIds]);

  // Reset to first page whenever the account filter changes.
  useEffect(() => {
    setOffset(0);
  }, [selectedAccountIds]);

  function toggleAccount(id: string) {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function onHeaderClick(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'amount' || key === 'date' ? 'desc' : 'asc');
    }
  }

  async function onTxnUpdate(
    id: string,
    updates: { categoryId?: string | null; clearedAt?: string | null },
  ) {
    try {
      await api.updateTransaction(id, updates);
      setTransactions((prev) => prev.filter((t) => t.id !== id));
      setTotal((n) => Math.max(0, n - 1));
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update transaction');
    }
  }

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Uncategorized</h1>
          <div className="subtitle">
            Triage queue — transactions that need a human touch before they
            can fit anywhere else. Pick a category (or split) and the row
            disappears from this list.
          </div>
        </div>
        <span className="muted">
          {total === 0 ? '0' : `${from}–${to} of ${total}`}
        </span>
      </div>

      {accounts.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ marginTop: 0 }}>
            Accounts ({selectedAccountIds.length === 0 ? 'all' : `${selectedAccountIds.length} selected`})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {accounts.map((a) => {
              const on = selectedAccountIds.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`account-chip ${on ? 'selected' : ''}`}
                  onClick={() => toggleAccount(a.id)}
                >
                  {on && <span aria-hidden style={{ marginRight: 4 }}>✓</span>}
                  {a.name}
                </button>
              );
            })}
            {selectedAccountIds.length > 0 && (
              <button
                type="button"
                className="btn-link"
                onClick={() => setSelectedAccountIds([])}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {error && <div className="banner error">{error}</div>}

      <BulkActionBar
        selectedIds={Array.from(selectedIds)}
        categories={categories}
        onClear={() => setSelectedIds(new Set())}
        onApplied={() => {
          setSelectedIds(new Set());
          void load(offset);
        }}
        onCaptureRule={async (input) => {
          try {
            await api.createNormalizationRule(input);
          } catch (e) {
            if (!(e instanceof Error && /already exists/i.test(e.message))) {
              throw e;
            }
          }
        }}
        allowDelete
      />

      {loading ? (
        <p className="empty">Loading…</p>
      ) : transactions.length === 0 ? (
        <p className="empty">
          Nothing uncategorized — every transaction has a home.
        </p>
      ) : (
        <TransactionTable
          transactions={transactions}
          showAccount
          categories={categories}
          onUpdate={onTxnUpdate}
          onOpenSplits={setSplittingFor}
          sort={{ key: sortKey, dir: sortDir, onChange: onHeaderClick }}
          selection={{
            selected: selectedIds,
            onToggle: (id) =>
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              }),
            onToggleAll: (ids) =>
              setSelectedIds((prev) => {
                const allSelected = ids.every((id) => prev.has(id));
                if (allSelected) {
                  const next = new Set(prev);
                  for (const id of ids) next.delete(id);
                  return next;
                }
                const next = new Set(prev);
                for (const id of ids) next.add(id);
                return next;
              }),
          }}
        />
      )}

      {splittingFor && (
        <SplitsModal
          transaction={splittingFor}
          categories={categories}
          onClose={() => setSplittingFor(null)}
          onSaved={() => {
            setSplittingFor(null);
            void load(offset);
          }}
        />
      )}

      {total > PAGE_SIZE && (
        <div className="pagination">
          <button
            className="btn secondary"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            ← Previous
          </button>
          <button
            className="btn secondary"
            disabled={to >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
