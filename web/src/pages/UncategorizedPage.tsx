import { useEffect, useState } from 'react';
import { api, type Category, type Transaction } from '../api';
import { TransactionTable } from '../components/TransactionTable';
import { BulkActionBar } from '../components/BulkActionBar';
import { SplitsModal } from '../components/SplitsModal';

const PAGE_SIZE = 100;

export function UncategorizedPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [splittingFor, setSplittingFor] = useState<Transaction | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.listCategories().then(setCategories).catch(() => undefined);
  }, []);

  async function load(nextOffset: number) {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listTransactions({
        limit: PAGE_SIZE,
        offset: nextOffset,
        uncategorized: true,
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
  }, [offset]);

  async function onTxnUpdate(
    id: string,
    updates: { categoryId: string | null },
  ) {
    try {
      await api.updateTransaction(id, updates);
      // Once a row gets a category, it disappears from the triage list.
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
