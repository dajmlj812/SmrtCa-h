import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { Category } from '../api';

/**
 * 0.21.x — fuzzy-searchable category combobox.
 *
 * Replaces the bare `<select>` used throughout the app. With ~150
 * canonical entries (federal tax lines + personal-finance) a flat
 * dropdown becomes hard to navigate — this one accepts a free-text
 * query and ranks candidates by:
 *
 *   1. exact name match (case-insensitive)
 *   2. prefix match
 *   3. word-start match (every space-separated chunk that starts
 *      with the query)
 *   4. substring match
 *   5. character-subsequence (every query char appears in order)
 *
 * Keyboard: ArrowUp / ArrowDown navigate, Enter selects, Esc closes.
 * Click anywhere outside closes the dropdown.
 */

interface Props {
  categories: readonly Category[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  /** Optional placeholder when nothing selected. */
  placeholder?: string;
  /** If true, the very first option becomes "Flex pool (everything else)". */
  allowFlex?: boolean;
  /** A subset of category ids to hide (e.g. already-selected ones). */
  excludeIds?: ReadonlySet<string>;
}

interface Scored {
  cat: Category;
  parentName: string | null;
  score: number;
}

function scoreCandidate(query: string, name: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 800;
  // Word-start: any space-separated word starts with the query.
  const words = n.split(/[\s\-/]+/);
  if (words.some((w) => w.startsWith(q))) return 600;
  if (n.includes(q)) return 400;
  // Character subsequence — every char of q appears in order.
  let i = 0;
  for (const ch of n) {
    if (i < q.length && ch === q[i]) i++;
    if (i === q.length) return 100;
  }
  return 0;
}

export function CategoryPicker({
  categories,
  value,
  onChange,
  disabled,
  placeholder = '— Pick a category —',
  allowFlex,
  excludeIds,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
    width: number;
    placement: 'below' | 'above';
  } | null>(null);

  // Index parents so we can show "Parent · Child" labels in the
  // dropdown.
  const parentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.id, c.name);
    return m;
  }, [categories]);

  const selected = useMemo(
    () => categories.find((c) => c.id === value) ?? null,
    [categories, value],
  );

  const ranked: Scored[] = useMemo(() => {
    const trimmed = query.trim();
    const list: Scored[] = [];
    for (const c of categories) {
      if (excludeIds?.has(c.id)) continue;
      const score = scoreCandidate(trimmed, c.name);
      if (trimmed && score === 0) continue;
      list.push({
        cat: c,
        parentName: c.parent_id ? parentNameById.get(c.parent_id) ?? null : null,
        score,
      });
    }
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.cat.name.localeCompare(b.cat.name);
    });
    return list.slice(0, 200);
  }, [categories, query, excludeIds, parentNameById]);

  // Anchor the popover to the input on open + on scroll/resize so
  // it stays attached. Portaled to document.body to escape any
  // .table-wrap { overflow: hidden } that would otherwise clip it.
  useLayoutEffect(() => {
    if (!open || !inputRef.current) return;
    function update() {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const POPOVER_HEIGHT_ESTIMATE = 320;
      const spaceBelow = window.innerHeight - r.bottom;
      const placeAbove =
        spaceBelow < POPOVER_HEIGHT_ESTIMATE && r.top > POPOVER_HEIGHT_ESTIMATE;
      setPopoverPos({
        top: placeAbove ? r.top - 2 : r.bottom + 2,
        left: r.left,
        width: Math.max(r.width, 320),
        placement: placeAbove ? 'above' : 'below',
      });
    }
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // Close on outside click. The popover is portaled, so the
  // containment check has to include it too.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (
        containerRef.current?.contains(target) ||
        document.getElementById('cat-picker-portal')?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  function commit(id: string | null) {
    onChange(id);
    setOpen(false);
    setQuery('');
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlightIdx((i) => Math.min(i + 1, ranked.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (allowFlex && highlightIdx === 0) {
        commit(null);
        return;
      }
      const offset = allowFlex ? 1 : 0;
      const pick = ranked[highlightIdx - offset];
      if (pick) commit(pick.cat.id);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  }

  const display = open ? query : selected ? selected.name : '';

  return (
    <div
      ref={containerRef}
      className="cat-picker"
      style={{ position: 'relative' }}
    >
      <input
        ref={inputRef}
        type="text"
        className="cell-select"
        disabled={disabled}
        value={display}
        placeholder={selected ? selected.name : placeholder}
        onFocus={() => {
          setOpen(true);
          setHighlightIdx(0);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlightIdx(0);
        }}
        onKeyDown={handleKey}
      />
      {selected && !open && (
        <button
          type="button"
          className="cat-picker-clear"
          title="Clear category"
          onMouseDown={(e) => {
            e.preventDefault();
            commit(null);
          }}
        >
          ×
        </button>
      )}
      {open && popoverPos &&
        createPortal(
          <div
            id="cat-picker-portal"
            className="cat-picker-list"
            role="listbox"
            style={{
              position: 'fixed',
              top:
                popoverPos.placement === 'above'
                  ? undefined
                  : popoverPos.top,
              bottom:
                popoverPos.placement === 'above'
                  ? window.innerHeight - popoverPos.top
                  : undefined,
              left: popoverPos.left,
              minWidth: popoverPos.width,
            }}
          >
            {allowFlex && (
              <button
                type="button"
                role="option"
                className={`cat-picker-row ${highlightIdx === 0 ? 'hl' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(null);
                }}
                onMouseEnter={() => setHighlightIdx(0)}
              >
                <span><em>Flex pool (everything else)</em></span>
              </button>
            )}
            {ranked.length === 0 && (
              <div className="cat-picker-empty muted small">
                No matches for "{query}".
              </div>
            )}
            {ranked.map((r, i) => {
              const offset = allowFlex ? 1 : 0;
              const idx = i + offset;
              return (
                <button
                  key={r.cat.id}
                  type="button"
                  role="option"
                  className={`cat-picker-row ${idx === highlightIdx ? 'hl' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(r.cat.id);
                  }}
                  onMouseEnter={() => setHighlightIdx(idx)}
                >
                  <span className="cat-picker-name">
                    {r.parentName && (
                      <span className="muted small">{r.parentName} ·{' '}</span>
                    )}
                    {r.cat.name}
                  </span>
                  {r.cat.tax_category && (
                    <span
                      className="cat-picker-tax muted small"
                      title="Auto-tagged for tax reports"
                    >
                      🏛 {r.cat.tax_category}
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
