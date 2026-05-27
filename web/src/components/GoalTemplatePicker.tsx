import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import {
  GOAL_TEMPLATES,
  placeholdersOf,
  buildGoalFromTemplate,
  type GoalTemplate,
  type Placeholder,
} from './goalTemplates';

/**
 * 0.21.x — pick-and-customize goal templates. User selects a
 * template from a searchable list, fills in the placeholders
 * (amount / months / years / pct / count / age), and the picker
 * creates the goal via /api/goals.
 */
export function GoalTemplatePicker({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<GoalTemplate | null>(null);
  const [values, setValues] = useState<Partial<Record<Placeholder, number>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GOAL_TEMPLATES;
    return GOAL_TEMPLATES.filter(
      (t) =>
        t.text.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q),
    );
  }, [query]);

  function selectTemplate(t: GoalTemplate) {
    setSelected(t);
    setValues({ ...t.defaults });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const built = buildGoalFromTemplate(selected, values);
      await api.createGoal({
        name: built.name,
        targetAmountCents: built.targetAmountCents,
        targetDate: built.targetDate,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create goal');
    } finally {
      setSubmitting(false);
    }
  }

  if (selected) {
    // The form always includes an "amount" field — even when the
    // template text doesn't reference it — because the goal row
    // needs a positive targetAmountCents to track progress.
    // Templates like "Pay off all credit card debt" use it as
    // "what's the balance you're trying to pay off."
    const textPlaceholders = placeholdersOf(selected);
    const placeholders: Placeholder[] = textPlaceholders.includes('amount')
      ? textPlaceholders
      : ['amount', ...textPlaceholders];
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true">
        <form className="modal" onSubmit={submit} style={{ maxWidth: 520 }}>
          <h2>Customize your goal</h2>
          <p className="muted">{selected.text}</p>
          {error && <div className="banner error">{error}</div>}
          {placeholders.map((key) => (
            <div className="field" key={key}>
              <label htmlFor={`tpl-${key}`}>
                {labelFor(key)}
                {key === 'amount' && !textPlaceholders.includes('amount') && (
                  <span className="muted small">
                    {' '}· the dollar number this goal tracks (current debt,
                    target savings, etc.)
                  </span>
                )}
              </label>
              <input
                id={`tpl-${key}`}
                type="number"
                step={key === 'amount' ? '0.01' : '1'}
                min={key === 'amount' ? '0.01' : '0'}
                value={values[key] ?? ''}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setValues((prev) => ({
                    ...prev,
                    [key]: Number.isFinite(v) ? v : undefined,
                  }));
                }}
                required={key === 'amount'}
              />
            </div>
          ))}
          <div className="modal-footer">
            <button
              type="button"
              className="btn secondary"
              onClick={() => setSelected(null)}
            >
              ← Back to list
            </button>
            <button type="button" className="btn secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Saving…' : 'Create goal'}
            </button>
          </div>
        </form>
      </div>
    );
  }

  // Grouped by category for readability.
  const byCategory = new Map<string, GoalTemplate[]>();
  for (const t of filtered) {
    const arr = byCategory.get(t.category) ?? [];
    arr.push(t);
    byCategory.set(t.category, arr);
  }
  const categories = [...byCategory.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal" style={{ maxWidth: 720, maxHeight: '85vh', overflow: 'auto' }}>
        <h2>Choose a goal template</h2>
        <p className="muted small">
          Pick a starting point. You'll fill in the dollar amount, timeframe,
          or percentage on the next screen — and edit it any time afterward.
        </p>
        <div className="field">
          <label htmlFor="tpl-search">Search</label>
          <input
            id="tpl-search"
            type="search"
            placeholder="emergency, retirement, college, debt…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {categories.length === 0 ? (
          <p className="empty">No templates match "{query}".</p>
        ) : (
          categories.map(([cat, list]) => (
            <div key={cat} style={{ marginTop: 14 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--muted)' }}>
                {cat}
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {list.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="goal-template-row"
                    onClick={() => selectTemplate(t)}
                  >
                    {t.text}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
        <div className="modal-footer">
          <button type="button" className="btn secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function labelFor(p: Placeholder): string {
  switch (p) {
    case 'amount':
      return 'Target dollar amount';
    case 'months':
      return 'Number of months';
    case 'years':
      return 'Number of years';
    case 'pct':
      return 'Percent';
    case 'count':
      return 'Count';
    case 'age':
      return 'Target age';
  }
}
