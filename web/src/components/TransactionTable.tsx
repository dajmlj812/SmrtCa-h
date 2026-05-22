import { useMemo, useState } from 'react';
import type { Category, Transaction } from '../api';
import { formatCents, formatDate } from '../format';

interface Props {
  transactions: Transaction[];
  showAccount?: boolean;
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
  categories,
  onUpdate,
  onOpenAttachments,
}: Props) {
  const groups = useMemo(
    () => (categories ? buildCategoryGroups(categories) : []),
    [categories],
  );

  if (transactions.length === 0) {
    return <p className="empty">No transactions yet.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="txn-table">
        <thead>
          <tr>
            <th>Date</th>
            {showAccount && <th>Account</th>}
            <th>Description</th>
            <th>Category</th>
            <th className="num">Amount</th>
            {onOpenAttachments && <th className="attach-col">Receipt</th>}
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => (
            <TransactionRow
              key={t.id}
              transaction={t}
              showAccount={showAccount}
              groups={groups}
              hasCategories={categories !== undefined}
              onUpdate={onUpdate}
              onOpenAttachments={onOpenAttachments}
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
  groups,
  hasCategories,
  onUpdate,
  onOpenAttachments,
}: {
  transaction: Transaction;
  showAccount: boolean;
  groups: CategoryGroup[];
  hasCategories: boolean;
  onUpdate?: Props['onUpdate'];
  onOpenAttachments?: Props['onOpenAttachments'];
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

  return (
    <tr>
      <td className="nowrap">{formatDate(t.txn_date)}</td>
      {showAccount && <td>{t.account_name}</td>}
      <td className="desc">
        <span className="desc-main">
          {t.normalized_merchant ?? t.raw_description}
        </span>
        <span className="desc-meta">
          <StatusPill status={t.normalization_status} />
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
      {onOpenAttachments && (
        <td className="attach-col">
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
        </td>
      )}
    </tr>
  );
}

function StatusPill({ status }: { status: string }) {
  const label = STATUS_LABEL[status] ?? status;
  return <span className={`pill status-${status}`}>{label}</span>;
}
