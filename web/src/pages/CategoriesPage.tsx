import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type Category, type CategorySuggestion } from '../api';

export function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[]>([]);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [cats, sugs] = await Promise.all([
        api.listCategories(),
        api.listSuggestions('pending'),
      ]);
      setCategories(cats);
      setSuggestions(sugs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load categories');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function submitCreate(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === '') return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createCategory(name.trim());
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create category');
    } finally {
      setSubmitting(false);
    }
  }

  async function saveRename(id: string) {
    if (editValue.trim() === '') {
      setEditing(null);
      return;
    }
    setError(null);
    try {
      await api.updateCategory(id, editValue.trim());
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename category');
    }
  }

  async function remove(c: Category) {
    if (
      !window.confirm(
        c.transaction_count > 0
          ? `Delete "${c.name}"? ${c.transaction_count} transaction(s) will have their category cleared.`
          : `Delete "${c.name}"?`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api.deleteCategory(c.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete category');
    }
  }

  // Categories grouped by parent for display.
  const groups = useMemo(() => {
    const byParent = new Map<string, Category[]>();
    const parents: Category[] = [];
    for (const c of categories) {
      if (c.parent_id === null) parents.push(c);
      else {
        const arr = byParent.get(c.parent_id) ?? [];
        arr.push(c);
        byParent.set(c.parent_id, arr);
      }
    }
    parents.sort((a, b) => a.name.localeCompare(b.name));
    return parents.map((p) => ({
      parent: p,
      children: (byParent.get(p.id) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }));
  }, [categories]);

  async function approveSuggestion(s: CategorySuggestion, parentId: string | null) {
    setError(null);
    try {
      await api.approveSuggestion(s.id, parentId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to approve suggestion');
    }
  }

  async function mergeSuggestion(s: CategorySuggestion, categoryId: string) {
    setError(null);
    try {
      await api.mergeSuggestion(s.id, categoryId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to merge suggestion');
    }
  }

  async function rejectSuggestion(s: CategorySuggestion) {
    if (
      !window.confirm(
        `Reject "${s.suggested_name}"? The ${s.transaction_count} affected transaction(s) will keep their current category.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api.rejectSuggestion(s.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reject suggestion');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Categories</h1>
          <div className="subtitle">
            The taxonomy your AI normalizer and manual edits choose from
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <SuggestionsPanel
        suggestions={suggestions}
        categories={categories}
        onApprove={approveSuggestion}
        onMerge={mergeSuggestion}
        onReject={rejectSuggestion}
      />

      <form className="card" style={{ marginBottom: 24 }} onSubmit={submitCreate}>
        <div className="section-title" style={{ marginTop: 0 }}>
          New category
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'end' }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="new-category-name">Name *</label>
            <input
              id="new-category-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Pet Care"
              required
            />
          </div>
          <button className="btn" type="submit" disabled={submitting || !name.trim()}>
            {submitting ? 'Adding…' : 'Add Category'}
          </button>
        </div>
      </form>

      {loading ? (
        <p className="empty">Loading…</p>
      ) : (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>
            All categories ({categories.length})
          </div>
          {groups.map(({ parent, children }) => (
            <div key={parent.id} className="cat-group">
              <CategoryRow
                category={parent}
                isParent
                editing={editing === parent.id}
                editValue={editValue}
                onEditStart={() => {
                  setEditing(parent.id);
                  setEditValue(parent.name);
                }}
                onEditChange={setEditValue}
                onSave={() => void saveRename(parent.id)}
                onCancel={() => setEditing(null)}
                onDelete={() => void remove(parent)}
              />
              {children.map((c) => (
                <CategoryRow
                  key={c.id}
                  category={c}
                  isParent={false}
                  editing={editing === c.id}
                  editValue={editValue}
                  onEditStart={() => {
                    setEditing(c.id);
                    setEditValue(c.name);
                  }}
                  onEditChange={setEditValue}
                  onSave={() => void saveRename(c.id)}
                  onCancel={() => setEditing(null)}
                  onDelete={() => void remove(c)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryRow({
  category,
  isParent,
  editing,
  editValue,
  onEditStart,
  onEditChange,
  onSave,
  onCancel,
  onDelete,
}: {
  category: Category;
  isParent: boolean;
  editing: boolean;
  editValue: string;
  onEditStart: () => void;
  onEditChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`cat-row ${isParent ? 'cat-parent' : 'cat-child'}`}>
      <div className="cat-name">
        {editing ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave();
              if (e.key === 'Escape') onCancel();
            }}
            onBlur={onSave}
          />
        ) : (
          <>
            {!isParent && <span className="cat-prefix">↳</span>}
            <span className={isParent ? 'cat-parent-name' : ''}>
              {category.name}
            </span>
          </>
        )}
      </div>
      <div className="cat-count muted">{category.transaction_count} txns</div>
      <div className="cat-actions">
        {editing ? (
          <button className="btn secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <>
            <button className="btn secondary" onClick={onEditStart}>
              Rename
            </button>
            <button className="btn danger" onClick={onDelete}>
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SuggestionsPanel({
  suggestions,
  categories,
  onApprove,
  onMerge,
  onReject,
}: {
  suggestions: CategorySuggestion[];
  categories: Category[];
  onApprove: (s: CategorySuggestion, parentId: string | null) => Promise<void>;
  onMerge: (s: CategorySuggestion, categoryId: string) => Promise<void>;
  onReject: (s: CategorySuggestion) => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<'approve' | 'merge' | null>(null);
  const [parentChoice, setParentChoice] = useState('');
  const [mergeChoice, setMergeChoice] = useState('');

  if (suggestions.length === 0) return null;

  const parents = categories
    .filter((c) => c.parent_id === null)
    .sort((a, b) => a.name.localeCompare(b.name));

  function openApprove(s: CategorySuggestion) {
    setOpenId(s.id);
    setMode('approve');
    setParentChoice('');
  }
  function openMerge(s: CategorySuggestion) {
    setOpenId(s.id);
    setMode('merge');
    setMergeChoice('');
  }
  function closeRow() {
    setOpenId(null);
    setMode(null);
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        Suggested categories ({suggestions.length})
      </div>
      <p className="muted" style={{ marginBottom: 16 }}>
        The AI proposed these category names. Approve to create each one, merge
        into an existing category, or reject.
      </p>
      <div>
        {suggestions.map((s) => {
          const isOpen = openId === s.id;
          return (
            <div key={s.id} className="suggestion-row">
              <div className="suggestion-summary">
                <strong>{s.suggested_name}</strong>
                <span className="muted">
                  {' '}
                  · {s.transaction_count} transaction
                  {s.transaction_count === 1 ? '' : 's'} affected
                </span>
              </div>
              <div className="suggestion-actions">
                <button className="btn" onClick={() => openApprove(s)}>
                  Approve…
                </button>
                <button className="btn secondary" onClick={() => openMerge(s)}>
                  Merge…
                </button>
                <button className="btn danger" onClick={() => void onReject(s)}>
                  Reject
                </button>
              </div>
              {isOpen && mode === 'approve' && (
                <div className="suggestion-detail">
                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor={`approve-parent-${s.id}`}>
                      Place under (optional)
                    </label>
                    <select
                      id={`approve-parent-${s.id}`}
                      value={parentChoice}
                      onChange={(e) => setParentChoice(e.target.value)}
                    >
                      <option value="">— Top level —</option>
                      {parents.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    className="btn"
                    onClick={async () => {
                      await onApprove(s, parentChoice || null);
                      closeRow();
                    }}
                  >
                    Create "{s.suggested_name}"
                  </button>
                  <button className="btn secondary" onClick={closeRow}>
                    Cancel
                  </button>
                </div>
              )}
              {isOpen && mode === 'merge' && (
                <div className="suggestion-detail">
                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor={`merge-target-${s.id}`}>
                      Merge into existing category
                    </label>
                    <select
                      id={`merge-target-${s.id}`}
                      value={mergeChoice}
                      onChange={(e) => setMergeChoice(e.target.value)}
                    >
                      <option value="">— pick one —</option>
                      {categories
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <button
                    className="btn"
                    disabled={!mergeChoice}
                    onClick={async () => {
                      await onMerge(s, mergeChoice);
                      closeRow();
                    }}
                  >
                    Merge
                  </button>
                  <button className="btn secondary" onClick={closeRow}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
