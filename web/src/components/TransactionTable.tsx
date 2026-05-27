import { useMemo, useState, type ReactNode } from 'react';
import type { Category, RefundStatus, Transaction } from '../api';
import { REFUND_STATUS_LABELS } from '../api';
import { formatCents, formatDate } from '../format';
import { CategoryPicker } from './CategoryPicker';

export type SortKey =
  | 'date'
  | 'account'
  | 'description'
  | 'category'
  | 'amount';

function compareForSort(
  a: Transaction,
  b: Transaction,
  key: SortKey,
): number {
  switch (key) {
    case 'date':
      return a.txn_date.localeCompare(b.txn_date);
    case 'account':
      return a.account_name.localeCompare(b.account_name);
    case 'description': {
      const av = (a.normalized_merchant ?? a.raw_description).toLowerCase();
      const bv = (b.normalized_merchant ?? b.raw_description).toLowerCase();
      return av.localeCompare(bv);
    }
    case 'category': {
      const av = (a.category_name ?? '').toLowerCase();
      const bv = (b.category_name ?? '').toLowerCase();
      return av.localeCompare(bv);
    }
    case 'amount':
      return a.amount_cents - b.amount_cents;
  }
}

const REFUND_PILL_TONE: Record<RefundStatus, string> = {
  refund_pending: 'warn',
  refunded: 'pos',
  chargeback_initiated: 'warn',
  disputed: 'warn',
  closed: '',
};

interface Props {
  transactions: Transaction[];
  showAccount?: boolean;
  /** When true, render the per-account running balance column. */
  showRunningBalance?: boolean;
  /** When provided, the Category cell becomes an inline dropdown. */
  categories?: Category[];
  /**
   * Called when the user edits a row. Resolves with the updated transaction so
   * the parent can mutate its local state.
   */
  onUpdate?: (
    id: string,
    // 0.19.2 — clearedAt added so the cleared-toggle column can
    // round-trip through the same callback as category edits.
    // 0.21.1 — refundStatus/refundNote added for the refund/chargeback flow.
    updates: {
      categoryId?: string | null;
      clearedAt?: string | null;
      refundStatus?: RefundStatus | null;
      refundNote?: string | null;
    },
  ) => Promise<void>;
  /** Called when the user clicks the attachments icon on a row. */
  onOpenAttachments?: (transaction: Transaction) => void;
  /** Called when the user clicks the split icon on a row. */
  onOpenSplits?: (transaction: Transaction) => void;
  /** Called when the user clicks the share-with-people icon on a row. */
  onOpenShares?: (transaction: Transaction) => void;
  /** 0.21.1 — Called when the user wants to set/edit refund status. */
  onOpenRefund?: (transaction: Transaction) => void;
  /**
   * 0.21.x — optional column sort. When provided, the header cells
   * become clickable; the table sorts client-side before mapping.
   * Pages that want server-side sort can ignore this.
   */
  sort?: {
    key: SortKey;
    dir: 'asc' | 'desc';
    onChange: (key: SortKey) => void;
  };
  /** When provided, render a checkbox column and report changes. */
  selection?: {
    selected: Set<string>;
    onToggle: (id: string) => void;
    onToggleAll: (ids: string[]) => void;
  };
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  normalized: 'AI',
  manual: 'Manual',
  skipped: 'Skipped',
};

interface CategoryGroup {
  parent: Category;
  children: Category[];
}

/** Build the optgroup structure from the flat category list. */
function buildCategoryGroups(categories: Category[]): CategoryGroup[] {
  const byParent = new Map<string, Category[]>();
  const parents: Category[] = [];
  for (const c of categories) {
    if (c.parent_id === null) {
      parents.push(c);
    } else {
      const arr = byParent.get(c.parent_id) ?? [];
      arr.push(c);
      byParent.set(c.parent_id, arr);
    }
  }
  parents.sort((a, b) => a.name.localeCompare(b.name));
  return parents.map((parent) => ({
    parent,
    children: (byParent.get(parent.id) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  }));
}

export function TransactionTable({
  transactions,
  showAccount = false,
  showRunningBalance = false,
  categories,
  onUpdate,
  onOpenAttachments,
  onOpenSplits,
  onOpenShares,
  onOpenRefund,
  selection,
  sort,
}: Props) {
  const groups = useMemo(
    () => (categories ? buildCategoryGroups(categories) : []),
    [categories],
  );

  // Sort client-side when a sort config is provided. Stable: ties
  // fall back to the original order.
  const sorted = useMemo(() => {
    if (!sort) return transactions;
    const arr = [...transactions];
    arr.sort((a, b) => {
      const cmp = compareForSort(a, b, sort.key);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [transactions, sort]);

  if (sorted.length === 0) {
    return <p className="empty">No transactions yet.</p>;
  }
  const allIds = sorted.map((t) => t.id);
  const allChecked =
    !!selection && allIds.length > 0 && allIds.every((id) => selection.selected.has(id));
  const someChecked =
    !!selection && allIds.some((id) => selection.selected.has(id)) && !allChecked;
  return (
    <div className="table-wrap">
      <table className="txn-table txn-table-compact">
        <thead>
          <tr>
            {selection && (
              <th className="check-col">
                <input
                  type="checkbox"
                  aria-label="Select all on page"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked;
                  }}
                  onChange={() => selection.onToggleAll(allIds)}
                />
              </th>
            )}
            {/* 0.19.2 — cleared toggle column. Tiny checkbox so the
                column doesn't dominate; tooltip explains intent. */}
            <th className="cleared-col" title="Cleared (reconciled to bank statement)">
              ✓
            </th>
            <SortHeader sort={sort} sortKey="date">Date</SortHeader>
            {showAccount && (
              <SortHeader sort={sort} sortKey="account">Account</SortHeader>
            )}
            <SortHeader sort={sort} sortKey="description">Description</SortHeader>
            <SortHeader sort={sort} sortKey="category">Category</SortHeader>
            <SortHeader sort={sort} sortKey="amount" align="right">
              Amount
            </SortHeader>
            {showRunningBalance && <th className="num">Balance</th>}
            {(onOpenAttachments || onOpenSplits || onOpenShares) && (
              <th className="attach-col">Actions</th>
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => (
            <TransactionRow
              key={t.id}
              transaction={t}
              showAccount={showAccount}
              showRunningBalance={showRunningBalance}
              groups={groups}
              categories={categories ?? []}
              hasCategories={categories !== undefined}
              onUpdate={onUpdate}
              onOpenAttachments={onOpenAttachments}
              onOpenSplits={onOpenSplits}
              onOpenShares={onOpenShares}
              onOpenRefund={onOpenRefund}
              selection={selection}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TransactionRow({
  transaction,
  showAccount,
  showRunningBalance,
  groups: _groups,
  categories,
  hasCategories,
  onUpdate,
  onOpenAttachments,
  onOpenSplits,
  onOpenShares,
  onOpenRefund,
  selection,
}: {
  transaction: Transaction;
  showAccount: boolean;
  showRunningBalance: boolean;
  groups: CategoryGroup[];
  categories: readonly Category[];
  hasCategories: boolean;
  onUpdate?: Props['onUpdate'];
  onOpenAttachments?: Props['onOpenAttachments'];
  onOpenSplits?: Props['onOpenSplits'];
  onOpenShares?: Props['onOpenShares'];
  onOpenRefund?: Props['onOpenRefund'];
  selection?: Props['selection'];
}) {
  const t = transaction;
  const editable = hasCategories && onUpdate !== undefined;
  const [saving, setSaving] = useState(false);

  async function handleCategoryChange(value: string) {
    if (!onUpdate) return;
    const categoryId = value === '' ? null : value;
    setSaving(true);
    try {
      await onUpdate(t.id, { categoryId });
    } finally {
      setSaving(false);
    }
  }

  const isSelected = selection?.selected.has(t.id) ?? false;
  return (
    <tr className={isSelected ? 'selected' : ''}>
      {selection && (
        <td className="check-col">
          <input
            type="checkbox"
            aria-label={`Select transaction ${t.id}`}
            checked={isSelected}
            onChange={() => selection.onToggle(t.id)}
          />
        </td>
      )}
      <td className="cleared-col">
        <input
          type="checkbox"
          aria-label={t.cleared_at ? 'Mark as uncleared' : 'Mark as cleared'}
          checked={t.cleared_at !== null}
          disabled={saving || !onUpdate}
          title={
            t.cleared_at
              ? `Cleared ${new Date(t.cleared_at).toLocaleDateString()}`
              : 'Uncleared — pending reconcile'
          }
          onChange={async () => {
            if (!onUpdate) return;
            setSaving(true);
            try {
              await onUpdate(t.id, {
                clearedAt: t.cleared_at ? null : new Date().toISOString(),
              });
            } finally {
              setSaving(false);
            }
          }}
        />
      </td>
      <td className="nowrap">{formatDate(t.txn_date)}</td>
      {showAccount && <td>{t.account_name}</td>}
      <td className="desc">
        <span className="desc-main">
          {t.normalized_merchant ?? t.raw_description}
          <StatusPill status={t.normalization_status} />
          {t.transfer_group_id && (
            <span
              className="pill transfer-pill"
              title="Linked transfer — excluded from spending totals"
            >
              ↔ transfer
            </span>
          )}
          {t.refund_status && (
            <button
              type="button"
              className={`pill ${REFUND_PILL_TONE[t.refund_status] || ''}`}
              title={
                (t.refund_note ? `${t.refund_note} — ` : '') +
                (t.refund_updated_at
                  ? `Updated ${new Date(t.refund_updated_at).toLocaleDateString()}`
                  : '')
              }
              onClick={() => onOpenRefund?.(t)}
              disabled={!onOpenRefund}
              style={{
                cursor: onOpenRefund ? 'pointer' : 'default',
                border: 0,
              }}
            >
              ↩ {REFUND_STATUS_LABELS[t.refund_status]}
            </button>
          )}
        </span>
        {t.normalized_merchant && (
          <span
            className="desc-sub"
            title={t.raw_description}
          >
            {t.raw_description}
          </span>
        )}
      </td>
      <td>
        {editable ? (
          <CategoryPicker
            categories={categories}
            value={t.category_id}
            disabled={saving}
            onChange={(id) => void handleCategoryChange(id ?? '')}
          />
        ) : (
          (t.category_name ?? t.source_category ?? (
            <span className="muted">—</span>
          ))
        )}
      </td>
      <td className={`num ${t.amount_cents < 0 ? 'neg' : 'pos'}`}>
        {formatCents(t.amount_cents)}
      </td>
      {showRunningBalance && (
        <td className="num">
          {t.running_balance_cents !== null ? (
            formatCents(t.running_balance_cents)
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      )}
      {(onOpenAttachments || onOpenSplits || onOpenShares || onOpenRefund) && (
        <td className="attach-col">
          {onOpenAttachments && (
            <button
              type="button"
              className={`attach-btn ${
                (t.attachment_count ?? 0) > 0 ? 'has-attachments' : ''
              }`}
              onClick={() => onOpenAttachments(t)}
              title={
                (t.attachment_count ?? 0) > 0
                  ? `${t.attachment_count} attachment(s)`
                  : 'Add a receipt'
              }
              aria-label="Open attachments"
            >
              <span aria-hidden>📎</span>
              {(t.attachment_count ?? 0) > 0 && (
                <span className="attach-count">{t.attachment_count}</span>
              )}
            </button>
          )}
          {onOpenSplits && (
            <button
              type="button"
              className="attach-btn"
              onClick={() => onOpenSplits(t)}
              title="Split this transaction"
              aria-label="Split transaction"
            >
              <span aria-hidden>✂</span>
            </button>
          )}
          {onOpenShares && (
            <button
              type="button"
              className="attach-btn"
              onClick={() => onOpenShares(t)}
              title="Share this transaction with other people"
              aria-label="Share transaction"
            >
              <span aria-hidden>👥</span>
            </button>
          )}
          {onOpenRefund && (
            <button
              type="button"
              className={`attach-btn ${t.refund_status ? 'has-attachments' : ''}`}
              onClick={() => onOpenRefund(t)}
              title={
                t.refund_status
                  ? `Refund: ${REFUND_STATUS_LABELS[t.refund_status]}`
                  : 'Track refund / chargeback'
              }
              aria-label="Track refund"
            >
              <span aria-hidden>↩</span>
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

function StatusPill({ status }: { status: string }) {
  const label = STATUS_LABEL[status] ?? status;
  return <span className={`pill status-${status}`}>{label}</span>;
}

function SortHeader({
  sort,
  sortKey,
  align,
  children,
}: {
  sort?: Props['sort'];
  sortKey: SortKey;
  align?: 'right';
  children: ReactNode;
}) {
  if (!sort) {
    return <th className={align === 'right' ? 'num' : ''}>{children}</th>;
  }
  const active = sort.key === sortKey;
  const arrow = active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      className={align === 'right' ? 'num sortable' : 'sortable'}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      onClick={() => sort.onChange(sortKey)}
      title={`Sort by ${sortKey}${active ? `, currently ${sort.dir}ending` : ''}`}
    >
      {children}{arrow}
    </th>
  );
}
