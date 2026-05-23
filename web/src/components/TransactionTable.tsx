import { useMemo, useState } from 'react';
import type { Category, Transaction } from '../api';
import { formatCents, formatDate } from '../format';

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
    updates: { categoryId: string | null },
  ) => Promise<void>;
  /** Called when the user clicks the attachments icon on a row. */
  onOpenAttachments?: (transaction: Transaction) => void;
  /** Called when the user clicks the split icon on a row. */
  onOpenSplits?: (transaction: Transaction) => void;
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
  selection,
}: Props) {
  const groups = useMemo(
    () => (categories ? buildCategoryGroups(categories) : []),
    [categories],
  );

  if (transactions.length === 0) {
    return <p className="empty">No transactions yet.</p>;
  }
  const allIds = transactions.map((t) => t.id);
  const allChecked =
    !!selection && allIds.length > 0 && allIds.every((id) => selection.selected.has(id));
  const someChecked =
    !!selection && allIds.some((id) => selection.selected.has(id)) && !allChecked;
  return (
    <div className="table-wrap">
      <table className="txn-table">
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
            <th>Date</th>
            {showAccount && <th>Account</th>}
            <th>Description</th>
            <th>Category</th>
            <th className="num">Amount</th>
            {showRunningBalance && <th className="num">Balance</th>}
            {(onOpenAttachments || onOpenSplits) && (
              <th className="attach-col">Actions</th>
            )}
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => (
            <TransactionRow
              key={t.id}
              transaction={t}
              showAccount={showAccount}
              showRunningBalance={showRunningBalance}
              groups={groups}
              hasCategories={categories !== undefined}
              onUpdate={onUpdate}
              onOpenAttachments={onOpenAttachments}
              onOpenSplits={onOpenSplits}
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
  groups,
  hasCategories,
  onUpdate,
  onOpenAttachments,
  onOpenSplits,
  selection,
}: {
  transaction: Transaction;
  showAccount: boolean;
  showRunningBalance: boolean;
  groups: CategoryGroup[];
  hasCategories: boolean;
  onUpdate?: Props['onUpdate'];
  onOpenAttachments?: Props['onOpenAttachments'];
  onOpenSplits?: Props['onOpenSplits'];
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
      <td className="nowrap">{formatDate(t.txn_date)}</td>
      {showAccount && <td>{t.account_name}</td>}
      <td className="desc">
        <span className="desc-main">
          {t.normalized_merchant ?? t.raw_description}
        </span>
        <span className="desc-meta">
          <StatusPill status={t.normalization_status} />
          {t.transfer_group_id && (
            <span
              className="pill transfer-pill"
              title="Linked transfer — excluded from spending totals"
            >
              ↔ transfer
            </span>
          )}
          {t.normalized_merchant && (
            <span className="desc-sub">{t.raw_description}</span>
          )}
        </span>
      </td>
      <td>
        {editable ? (
          <select
            className="cell-select"
            value={t.category_id ?? ''}
            disabled={saving}
            onChange={(e) => void handleCategoryChange(e.target.value)}
          >
            <option value="">— None —</option>
            {groups.map((g) =>
              g.children.length === 0 ? (
                <option key={g.parent.id} value={g.parent.id}>
                  {g.parent.name}
                </option>
              ) : (
                <optgroup key={g.parent.id} label={g.parent.name}>
                  <option value={g.parent.id}>{g.parent.name} (general)</option>
                  {g.children.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ),
            )}
          </select>
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
      {(onOpenAttachments || onOpenSplits) && (
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
        </td>
      )}
    </tr>
  );
}

function StatusPill({ status }: { status: string }) {
  const label = STATUS_LABEL[status] ?? status;
  return <span className={`pill status-${status}`}>{label}</span>;
}
