import { useEffect, useRef, useState } from 'react';
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
/**
 * 0.17.4 — normalize in chunks of this size so the UI gets to
 * update between batches. 10 ≈ 10–20s per chunk against the
 * Claude API (about a second per transaction), short enough to
 * feel responsive, large enough to amortize HTTP overhead.
 */
const NORMALIZE_CHUNK = 10;

type StatusFilter = 'all' | 'pending' | 'normalized' | 'manual';

interface NormalizeProgress {
  /** Cumulative across all chunks in this run. */
  processed: number;
  normalized: number;
  errors: number;
  /** Total pending at run start; the denominator. */
  total: number;
  /** Latest provider id from the server (same across chunks but echoed for the success banner). */
  provider: string;
}

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
  const [normalizeProgress, setNormalizeProgress] =
    useState<NormalizeProgress | null>(null);
  const [normalizeResult, setNormalizeResult] =
    useState<NormalizationSummary | null>(null);
  /**
   * 0.17.4 — set to true when the user clicks "Stop" mid-run.
   * The chunked loop checks this between batches and bails
   * cleanly without losing progress already committed.
   */
  const cancelNormalizeRef = useRef(false);
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

  /**
   * 0.17.4 — chunked normalization with live progress.
   * 0.17.5 — re-normalize prompt when already-normalized rows
   * exist, plus mode plumbing so the user can include them on
   * demand. Default is still "pending only" so an accidental
   * Normalize click never burns AI quota redoing finished work.
   *
   * Decision tree on click:
   *   • pending > 0, normalized = 0 → run pending-only (silent)
   *   • pending = 0, normalized = 0 → "nothing to do" banner, no run
   *   • pending > 0, normalized > 0 → ask: "redo the N already-
   *       normalized too?" → user picks pending-only or all
   *   • pending = 0, normalized > 0 → ask: "nothing pending; redo
   *       the N already-normalized?" → run all or cancel
   *
   * The server's POST /api/normalize accepts `limit` + `mode`,
   * so we get progress feedback by simply calling it repeatedly
   * with a small batch size and accumulating between calls.
   */
  async function runNormalize() {
    cancelNormalizeRef.current = false;
    setError(null);

    // Fetch counts BEFORE flipping the busy state, so the
    // confirm dialog doesn't fire under a disabled button /
    // active progress bar.
    let counts: { pending: number; normalized: number; manual: number };
    try {
      counts = await api.normalizeCounts(accountId || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read counts');
      return;
    }

    // Decide what to run.
    let mode: 'pending' | 'all';
    let total: number;
    if (counts.pending === 0 && counts.normalized === 0) {
      setError(null);
      setNormalizeResult({
        provider: provider || '',
        processed: 0,
        normalized: 0,
        errors: 0,
      });
      return;
    } else if (counts.pending > 0 && counts.normalized === 0) {
      mode = 'pending';
      total = counts.pending;
    } else if (counts.pending === 0 && counts.normalized > 0) {
      const ok = window.confirm(
        `No transactions are pending normalization. Re-run AI on the ${counts.normalized.toLocaleString()} already-normalized transaction${counts.normalized === 1 ? '' : 's'}? This will count against your monthly AI quota.`,
      );
      if (!ok) return;
      mode = 'all';
      total = counts.normalized;
    } else {
      // pending > 0 AND normalized > 0
      const redoAll = window.confirm(
        `${counts.pending.toLocaleString()} transaction${counts.pending === 1 ? '' : 's'} pending normalization.\n\n` +
          `Also re-run AI on the ${counts.normalized.toLocaleString()} already-normalized transaction${counts.normalized === 1 ? '' : 's'}?\n\n` +
          `OK = redo all  ·  Cancel = pending only (default)`,
      );
      mode = redoAll ? 'all' : 'pending';
      total = redoAll ? counts.pending + counts.normalized : counts.pending;
    }

    setNormalizing(true);
    setNormalizeResult(null);
    setNormalizeProgress({
      processed: 0,
      normalized: 0,
      errors: 0,
      total,
      provider: '',
    });

    let cumulative: NormalizeProgress = {
      processed: 0,
      normalized: 0,
      errors: 0,
      total,
      provider: '',
    };
    let safetyValve = Math.ceil((total / NORMALIZE_CHUNK) * 2) + 4;

    try {
      while (!cancelNormalizeRef.current && safetyValve-- > 0) {
        const batch = await api.normalize({
          ...(accountId ? { accountId } : {}),
          limit: NORMALIZE_CHUNK,
          mode,
        });
        if (batch.processed === 0) break;
        cumulative = {
          processed: cumulative.processed + batch.processed,
          normalized: cumulative.normalized + batch.normalized,
          errors: cumulative.errors + batch.errors,
          total,
          provider: batch.provider,
        };
        setNormalizeProgress(cumulative);
      }
      // Build a final summary in the same shape the old (single-
      // call) flow produced so the success banner code below
      // still renders correctly.
      setNormalizeResult({
        provider: cumulative.provider,
        processed: cumulative.processed,
        normalized: cumulative.normalized,
        errors: cumulative.errors,
      });
      await load({ accountId, search, offset });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Normalization failed');
    } finally {
      setNormalizing(false);
      setNormalizeProgress(null);
      cancelNormalizeRef.current = false;
    }
  }

  function stopNormalize() {
    cancelNormalizeRef.current = true;
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
        <div style={{ display: 'flex', gap: 8 }}>
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
          {normalizing && (
            <button className="btn secondary" onClick={stopNormalize}>
              Stop
            </button>
          )}
        </div>
      </div>

      {/*
        * 0.17.4 — live progress while the chunked loop runs.
        * Total comes from the pending-count call at run start;
        * "processed" updates between every chunk. We render a
        * thin progress bar + text counter so a long run feels
        * responsive instead of looking frozen.
        */}
      {normalizing && normalizeProgress && normalizeProgress.total > 0 && (
        <div className="banner info" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span>
              Normalizing… <strong>{normalizeProgress.processed}</strong> of{' '}
              <strong>{normalizeProgress.total}</strong>
              {normalizeProgress.errors > 0
                ? ` (${normalizeProgress.errors} error${normalizeProgress.errors === 1 ? '' : 's'})`
                : ''}
            </span>
            <span className="muted small">
              {Math.round(
                (normalizeProgress.processed / normalizeProgress.total) * 100,
              )}
              %
            </span>
          </div>
          <div
            style={{
              height: 6,
              background: 'var(--surface-3)',
              borderRadius: 3,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${(normalizeProgress.processed / normalizeProgress.total) * 100}%`,
                background: 'var(--accent)',
                transition: 'width 200ms ease',
              }}
            />
          </div>
        </div>
      )}

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
