import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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

  return (
    <div>
      <BillTriageQueue />
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
