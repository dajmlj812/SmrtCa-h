import { useCallback, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { BillsPage } from './BillsPage';
import { SubscriptionsPage } from './SubscriptionsPage';
import { BillTriageQueue } from '../components/BillTriageQueue';

/**
 * 0.22.0 — Recurring (unified Bills + Subscriptions).
 *
 * Both views read from the same `bills` table; the UX has
 * historically split them across two pages. This wrapper merges
 * them into /recurring with a tab control. /bills and
 * /subscriptions both redirect here so old bookmarks and links
 * keep working.
 *
 * The deeper unification of the underlying UI (one list with a
 * `kind` filter, one editor with the new matching fields, an
 * inline triage queue) lands incrementally in 0.22.x — this
 * wrapper preserves existing functionality without regression
 * while the new model rolls out behind it.
 */

type Tab = 'bills' | 'subscriptions';

function tabFromSearch(search: string): Tab {
  const p = new URLSearchParams(search);
  return p.get('view') === 'subscriptions' ? 'subscriptions' : 'bills';
}

export function RecurringPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(() => tabFromSearch(location.search));

  function select(next: Tab) {
    setTab(next);
    const p = new URLSearchParams(location.search);
    if (next === 'subscriptions') p.set('view', 'subscriptions');
    else p.delete('view');
    const q = p.toString();
    navigate(`/recurring${q ? `?${q}` : ''}`, { replace: true });
  }

  // 0.22.1 — banner shown after a Rescan or Sweep action so the
  // user sees what the engine did without surprising them with a
  // silent reload.
  const [actionBanner, setActionBanner] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<'rescan' | 'sweep' | null>(null);
  // Bumping this counter triggers BillTriageQueue to reload, so a
  // Rescan that lands new triage rows shows them immediately.
  const [refreshKey, setRefreshKey] = useState(0);

  const rescan = useCallback(async () => {
    setActionBusy('rescan');
    setActionBanner(null);
    try {
      const r = await api.rescanBills();
      setActionBanner(
        `Rescanned ${r.scanned} transactions — ${r.matched} auto-matched, ${r.triaged} sent to triage.`,
      );
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setActionBanner(
        `Rescan failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setActionBusy(null);
    }
  }, []);

  const sweep = useCallback(async () => {
    setActionBusy('sweep');
    setActionBanner(null);
    try {
      const r = await api.sweepOverdueBills();
      setActionBanner(
        r.flipped > 0
          ? `Flipped ${r.flipped} past-due bill${r.flipped === 1 ? '' : 's'} to overdue.`
          : 'No bills past due grace window.',
      );
    } catch (e) {
      setActionBanner(
        `Sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setActionBusy(null);
    }
  }, []);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <button
          className="btn secondary"
          type="button"
          onClick={() => void rescan()}
          disabled={actionBusy !== null}
          title="Re-check the last 90 days of transactions against the bill set. Useful after editing a bill's merchant pattern or amount mode."
        >
          {actionBusy === 'rescan' ? 'Rescanning…' : 'Rescan transactions'}
        </button>
        <button
          className="btn secondary"
          type="button"
          onClick={() => void sweep()}
          disabled={actionBusy !== null}
          title="Force the overdue sweep right now instead of waiting for the hourly tick."
        >
          {actionBusy === 'sweep' ? 'Sweeping…' : 'Sweep overdue'}
        </button>
      </div>
      {actionBanner && (
        <div className="banner info" style={{ marginBottom: 12 }}>
          {actionBanner}
        </div>
      )}
      <BillTriageQueue key={refreshKey} />
      <div
        className="tab-strip"
        role="tablist"
        aria-label="Recurring views"
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--border)',
          marginBottom: 16,
        }}
      >
        <TabButton current={tab} value="bills" onSelect={select}>
          Bills
        </TabButton>
        <TabButton current={tab} value="subscriptions" onSelect={select}>
          Subscriptions
        </TabButton>
      </div>
      {tab === 'bills' ? <BillsPage /> : <SubscriptionsPage />}
    </div>
  );
}

function TabButton({
  current,
  value,
  onSelect,
  children,
}: {
  current: Tab;
  value: Tab;
  onSelect: (t: Tab) => void;
  children: ReactNode;
}) {
  const active = current === value;
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      onClick={() => onSelect(value)}
      style={{
        background: 'transparent',
        border: 'none',
        borderBottom: active
          ? '2px solid var(--accent)'
          : '2px solid transparent',
        color: active ? 'var(--accent)' : 'inherit',
        padding: '8px 14px',
        cursor: 'pointer',
        font: 'inherit',
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}
