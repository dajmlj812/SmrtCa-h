import { useEffect, useState } from 'react';
import {
  api,
  type Account,
  type Category,
  type NormalizationSummary,
  type Transaction,
} from '../api';
import { TransactionTable } from '../components/TransactionTable';
import { AttachmentsModal } from '../components/AttachmentsModal';
import { BulkActionBar } from '../components/BulkActionBar';
import { SplitsModal } from '../components/SplitsModal';
import { SplitTransactionModal } from '../components/SplitTransactionModal';

const PAGE_SIZE = 100;

type StatusFilter = 'all' | 'pending' | 'normalized' | 'manual';

export function TransactionsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [accountId, setAccountId] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [normalizing, setNormalizing] = useState(false);
  const [normalizeResult, setNormalizeResult] =
    useState<NormalizationSummary | null>(null);
  const [provider, setProvider] = useState<string>('');
  const [attachmentsFor, setAttachmentsFor] = useState<Transaction | null>(
    null,
  );
  const [splittingFor, setSplittingFor] = useState<Transaction | null>(null);
  const [sharingFor, setSharingFor] = useState<Transaction | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.listAccounts().then(setAccounts).catch(() => undefined);
    api.listCategories().then(setCategories).catch(() => undefined);
    api
      .aiStatus()
      .then((s) => setProvider(s.provider))
      .catch(() => undefined);
  }, []);

  async function load(opts: {
    accountId: string;
    search: string;
    offset: number;
  }) {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listTransactions({
        accountId: opts.accountId || undefined,
        search: opts.search || undefined,
        limit: PAGE_SIZE,
        offset: opts.offset,
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
    void load({ accountId, search, offset });
  }, [accountId, offset]);

  function runSearch() {
    setOffset(0);
    void load({ accountId, search, offset: 0 });
  }

  async function runNormalize() {
    setNormalizing(true);
    setNormalizeResult(null);
    setError(null);
    try {
      const summary = await api.normalize(
        accountId ? { accountId } : {},
      );
      setNormalizeResult(summary);
      await load({ accountId, search, offset });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Normalization failed');
    } finally {
      setNormalizing(false);
    }
  }

  async function onTxnUpdate(
    id: string,
    updates: { categoryId: string | null },
  ) {
    try {
      const updated = await api.updateTransaction(id, updates);
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === id
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

  const filtered =
    status === 'all'
      ? transactions
      : transactions.filter((t) => t.normalization_status === status);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  const providerLabel =
    provider === 'rules'
      ? 'rules-based'
      : provider === 'claude'
        ? 'Claude API'
        : provider === 'ollama'
          ? 'Ollama (local)'
          : provider === 'none'
            ? 'disabled'
            : provider;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Transactions</h1>
          <div className="subtitle">
            All imported transactions
            {provider && (
              <>
                {' '}
                · AI provider: <strong>{providerLabel}</strong>
              </>
            )}
          </div>
        </div>
        <button
          className="btn"
          disabled={normalizing || provider === 'none'}
          onClick={runNormalize}
          title={
            provider === 'none'
              ? 'Set AI_PROVIDER in .env to enable normalization'
              : 'Run AI normalization on pending transactions'
          }
        >
          {normalizing ? 'Normalizing…' : 'Normalize'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {normalizeResult && (
        <div className="banner success">
          Provider <strong>{normalizeResult.provider}</strong>:{' '}
          processed {normalizeResult.processed},{' '}
          normalized {normalizeResult.normalized}
          {normalizeResult.errors > 0
            ? `, ${normalizeResult.errors} errors`
            : ''}
          .
          {normalizeResult.errorDetails &&
            normalizeResult.errorDetails.length > 0 && (
              <div className="muted" style={{ marginTop: 4 }}>
                {normalizeResult.errorDetails.join(' · ')}
              </div>
            )}
        </div>
      )}

      <div className="toolbar">
        <select
          value={accountId}
          onChange={(e) => {
            setOffset(0);
            setAccountId(e.target.value);
          }}
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          <option value="all">All statuses</option>
          <option value="pending">Pending review</option>
          <option value="normalized">AI normalized</option>
          <option value="manual">Manually edited</option>
        </select>
        <input
          type="search"
          placeholder="Search descriptions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
        />
        <button className="btn secondary" onClick={runSearch}>
          Search
        </button>
        <a
          className="btn secondary"
          href={api.exportTransactionsUrl({
            accountId: accountId || undefined,
            search: search || undefined,
          })}
          title="Download the current filter as CSV"
        >
          Export CSV
        </a>
        <div className="spacer" />
        <span className="muted">
          {from}–{to} of {total}
        </span>
      </div>

      <BulkActionBar
        selectedIds={Array.from(selectedIds)}
        categories={categories}
        onClear={() => setSelectedIds(new Set())}
        onApplied={() => {
          setSelectedIds(new Set());
          void load({ accountId, search, offset });
        }}
        onCaptureRule={async (input) => {
          try {
            await api.createNormalizationRule(input);
          } catch (e) {
            // Duplicate pattern is OK — surface other errors.
            if (!(e instanceof Error && /already exists/i.test(e.message))) {
              throw e;
            }
          }
        }}
      />

      {loading ? (
        <p className="empty">Loading…</p>
      ) : (
        <TransactionTable
          transactions={filtered}
          showAccount
          categories={categories}
          onUpdate={onTxnUpdate}
          onOpenAttachments={setAttachmentsFor}
          onOpenSplits={setSplittingFor}
          onOpenShares={setSharingFor}
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

      {sharingFor && (
        <SplitTransactionModal
          transactionId={sharingFor.id}
          transactionAmountCents={sharingFor.amount_cents}
          transactionDescription={sharingFor.raw_description}
          onClose={() => setSharingFor(null)}
        />
      )}

      {splittingFor && (
        <SplitsModal
          transaction={splittingFor}
          categories={categories}
          onClose={() => setSplittingFor(null)}
          onSaved={() => {
            setSplittingFor(null);
            void load({ accountId, search, offset });
          }}
        />
      )}

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
    </div>
  );
}
