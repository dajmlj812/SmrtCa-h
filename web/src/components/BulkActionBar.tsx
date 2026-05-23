import { useState, type FormEvent } from 'react';
import { api, type Category } from '../api';

interface Props {
  selectedIds: string[];
  categories: Category[];
  onClear: () => void;
  /** Called after a successful bulk apply so the parent can reload + clear selection. */
  onApplied: () => void;
  /**
   * Called when the user wants to capture this bulk edit as a learned rule.
   * Receives the pattern + merchant + categoryId, returns the match count
   * (so the parent can show "applied to N transactions").
   */
  onCaptureRule?: (input: {
    pattern: string;
    normalizedMerchant: string | null;
    categoryId: string | null;
  }) => Promise<void>;
}

/**
 * Toolbar that appears when one or more transactions are selected. Lets
 * the user apply a category and/or merchant rename to all selected rows
 * in a single call, and optionally save the change as a learned rule.
 */
export function BulkActionBar({
  selectedIds,
  categories,
  onClear,
  onApplied,
  onCaptureRule,
}: Props) {
  const [categoryId, setCategoryId] = useState<string>('');
  const [merchant, setMerchant] = useState('');
  const [saveAsRule, setSaveAsRule] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (selectedIds.length === 0) return null;
  const hasChanges = categoryId !== '' || merchant.trim() !== '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!hasChanges) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const updates: { categoryId?: string | null; merchant?: string } = {};
      if (categoryId === '__clear') updates.categoryId = null;
      else if (categoryId !== '') updates.categoryId = categoryId;
      if (merchant.trim() !== '') updates.merchant = merchant.trim();

      const r = await api.bulkUpdateTransactions(selectedIds, updates);

      if (saveAsRule && merchant.trim() !== '' && onCaptureRule) {
        await onCaptureRule({
          pattern: merchant.trim(),
          normalizedMerchant: merchant.trim(),
          categoryId:
            updates.categoryId === undefined
              ? null
              : (updates.categoryId as string | null),
        });
      }

      setSuccess(`Updated ${r.updated} transaction${r.updated === 1 ? '' : 's'}.`);
      setCategoryId('');
      setMerchant('');
      setSaveAsRule(false);
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk edit failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="bulk-action-bar" onSubmit={submit}>
      <span className="bulk-count">
        {selectedIds.length} selected
      </span>
      <select
        className="cell-select"
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
        disabled={submitting}
      >
        <option value="">Category…</option>
        <option value="__clear">— Clear —</option>
        {categories
          .filter((c) => c.parent_id !== null)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
      <input
        type="text"
        placeholder="Set merchant (e.g. ONSTAR)"
        value={merchant}
        onChange={(e) => setMerchant(e.target.value)}
        disabled={submitting}
        className="bulk-merchant"
      />
      {onCaptureRule && merchant.trim() !== '' && (
        <label className="bulk-rule-toggle">
          <input
            type="checkbox"
            checked={saveAsRule}
            onChange={(e) => setSaveAsRule(e.target.checked)}
          />{' '}
          Save as rule
        </label>
      )}
      <button className="btn" type="submit" disabled={submitting || !hasChanges}>
        {submitting ? 'Applying…' : 'Apply'}
      </button>
      <button
        type="button"
        className="btn secondary"
        onClick={onClear}
        disabled={submitting}
      >
        Cancel
      </button>
      {error && <span className="bulk-error">{error}</span>}
      {success && <span className="bulk-success">{success}</span>}
    </form>
  );
}
