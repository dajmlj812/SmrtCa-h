import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReportColumn } from '../api';

/**
 * Reusable table with two power-user affordances on top of a basic
 * <table>:
 *
 *  1. **Show / hide columns** — a dropdown checklist toggles visibility
 *     per column. Persisted to localStorage keyed by `storageKey` so
 *     reloading the page (or coming back to the report later) keeps
 *     the user's choice.
 *
 *  2. **Per-column filtering** — toggleable filter row below the
 *     header. Each column gets a single text input. The input syntax
 *     depends on column type:
 *
 *      - **string**: case-insensitive substring match.
 *      - **number / cents / pct**: operator prefix (`>`, `<`, `>=`,
 *        `<=`, `=`) followed by a number, range `N..M` for inclusive
 *        between, or a bare number for substring match on the
 *        formatted display (so "1,234" finds "$1,234.56"). Cents
 *        columns accept dollar values — type `100` to mean $100.
 *      - **date**: same operator + ISO date set as numbers, or
 *        `YYYY-MM-DD..YYYY-MM-DD` for a range, or substring on the
 *        formatted display.
 *
 * The component is pure — it does the filtering client-side on the
 * rows you hand it and emits the filtered+visible-projected rows via
 * onChange so the parent can use them for CSV export.
 */

interface Props {
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  /** Renders one cell value the same way the table does — must match
   *  what the caller would print, so substring filters land naturally. */
  formatCell: (col: ReportColumn, raw: unknown) => string;
  /** localStorage key for persisted visibility. Pass null to skip persistence. */
  storageKey?: string | null;
  /** Called after every filter/visibility change with the current
   *  visible-column + matching-row projection (used for CSV export). */
  onProjectionChange?: (projection: {
    columns: ReportColumn[];
    rows: Array<Record<string, unknown>>;
  }) => void;
  /**
   * When provided, a per-row React fragment renderer (e.g. for action
   * buttons or inline editors). Each row gets one extra trailing cell
   * with this content.
   */
  rowActions?: (row: Record<string, unknown>) => React.ReactNode;
  /** Label for the row-actions header, when rowActions is provided. */
  rowActionsLabel?: string;
}

export function FilterableTable({
  columns,
  rows,
  formatCell,
  storageKey,
  onProjectionChange,
  rowActions,
  rowActionsLabel,
}: Props) {
  const allKeys = useMemo(() => columns.map((c) => c.key), [columns]);

  const [visible, setVisible] = useState<Set<string>>(() => {
    const stored = readStoredVisibility(storageKey);
    if (stored) return new Set(stored);
    return new Set(allKeys);
  });
  const [filtersOn, setFiltersOn] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [globalFilter, setGlobalFilter] = useState('');
  const [chooserOpen, setChooserOpen] = useState(false);
  const chooserRef = useRef<HTMLDivElement>(null);

  // Reset visibility set when the column set changes (different report
  // selected) — keep any stored choice that still aligns.
  useEffect(() => {
    const stored = readStoredVisibility(storageKey);
    if (stored) {
      const restored = new Set(stored.filter((k) => allKeys.includes(k)));
      // Don't end up with a fully-hidden table if storage was stale.
      setVisible(restored.size > 0 ? restored : new Set(allKeys));
    } else {
      setVisible(new Set(allKeys));
    }
    setFilters({});
  }, [allKeys.join('|'), storageKey]);

  // Persist visibility changes.
  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(
        `tableviz:${storageKey}`,
        JSON.stringify(Array.from(visible)),
      );
    } catch {
      /* private mode etc — ignore */
    }
  }, [visible, storageKey]);

  // Close the chooser when the user clicks outside.
  useEffect(() => {
    if (!chooserOpen) return;
    function onClick(e: MouseEvent) {
      if (!chooserRef.current?.contains(e.target as Node)) {
        setChooserOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [chooserOpen]);

  const visibleColumns = columns.filter((c) => visible.has(c.key));
  const filteredRows = useMemo(() => {
    const predicates = visibleColumns
      .map((c) => ({
        col: c,
        pred: buildPredicate(c, filters[c.key] ?? '', formatCell),
      }))
      .filter((p) => p.pred !== null);

    const globalNeedle = globalFilter.trim().toLowerCase();
    if (predicates.length === 0 && globalNeedle === '') return rows;

    return rows.filter((row) => {
      // Per-column filters: every active filter must match.
      for (const p of predicates) {
        if (!p.pred!(row[p.col.key], row)) return false;
      }
      // Global filter: fuzzy subsequence against the joined display of
      // every visible cell. "gth" matches "Groceries Total Health".
      if (globalNeedle !== '') {
        const haystack = visibleColumns
          .map((c) => formatCell(c, row[c.key]))
          .join(' ')
          .toLowerCase();
        if (!subsequenceMatch(haystack, globalNeedle)) return false;
      }
      return true;
    });
  }, [rows, visibleColumns, filters, globalFilter, formatCell]);

  // Emit projection upward whenever it changes.
  useEffect(() => {
    onProjectionChange?.({
      columns: visibleColumns,
      rows: filteredRows,
    });
  }, [visibleColumns, filteredRows, onProjectionChange]);

  function toggle(key: string): void {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size === 1) return prev; // keep at least one column visible
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const perColumnFilterCount = Object.values(filters).filter(
    (v) => v.trim() !== '',
  ).length;
  const globalActive = globalFilter.trim() !== '';
  const activeFilterCount = perColumnFilterCount + (globalActive ? 1 : 0);
  const hiddenCount = columns.length - visibleColumns.length;

  return (
    <div>
      <div className="table-toolbar">
        <input
          type="search"
          className="filter-global"
          placeholder="Fuzzy filter…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
        />
        <button
          type="button"
          className="btn secondary"
          onClick={() => setFiltersOn((on) => !on)}
        >
          {filtersOn ? 'Hide per-column' : 'Per-column'}
          {perColumnFilterCount > 0 && (
            <span className="badge">{perColumnFilterCount}</span>
          )}
        </button>
        {activeFilterCount > 0 && (
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              setFilters({});
              setGlobalFilter('');
            }}
          >
            Clear all
          </button>
        )}
        <div className="spacer" />
        <span className="muted">
          {filteredRows.length === rows.length
            ? `${rows.length} row${rows.length === 1 ? '' : 's'}`
            : `${filteredRows.length} of ${rows.length}`}
        </span>
        <div className="column-chooser" ref={chooserRef}>
          <button
            type="button"
            className="btn secondary"
            onClick={() => setChooserOpen((o) => !o)}
          >
            Columns
            {hiddenCount > 0 && <span className="badge">{visibleColumns.length}/{columns.length}</span>}
          </button>
          {chooserOpen && (
            <div className="column-chooser-menu">
              {columns.map((c) => (
                <label key={c.key} className="column-chooser-item">
                  <input
                    type="checkbox"
                    checked={visible.has(c.key)}
                    onChange={() => toggle(c.key)}
                  />{' '}
                  {c.label}
                </label>
              ))}
              <div className="column-chooser-actions">
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setVisible(new Set(allKeys))}
                >
                  Show all
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="table-wrap">
        <table className="txn-table">
          <thead>
            <tr>
              {visibleColumns.map((c) => (
                <th
                  key={c.key}
                  className={
                    c.type === 'cents' || c.type === 'number' || c.type === 'pct'
                      ? 'num'
                      : ''
                  }
                >
                  {c.label}
                </th>
              ))}
              {rowActions && <th>{rowActionsLabel ?? ''}</th>}
            </tr>
            {filtersOn && (
              <tr className="filter-row">
                {visibleColumns.map((c) => (
                  <th key={`f-${c.key}`}>
                    <input
                      type="text"
                      className="filter-input"
                      placeholder={placeholderFor(c)}
                      value={filters[c.key] ?? ''}
                      onChange={(e) =>
                        setFilters((prev) => ({
                          ...prev,
                          [c.key]: e.target.value,
                        }))
                      }
                    />
                  </th>
                ))}
                {rowActions && <th></th>}
              </tr>
            )}
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td
                  colSpan={visibleColumns.length + (rowActions ? 1 : 0)}
                  className="empty"
                >
                  No rows match the current filters.
                </td>
              </tr>
            ) : (
              filteredRows.map((row, i) => (
                <tr key={i}>
                  {visibleColumns.map((c) => (
                    <td
                      key={c.key}
                      className={
                        c.type === 'cents' ||
                        c.type === 'number' ||
                        c.type === 'pct'
                          ? 'num'
                          : ''
                      }
                    >
                      {formatCell(c, row[c.key])}
                    </td>
                  ))}
                  {rowActions && <td>{rowActions(row)}</td>}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Fuzzy subsequence match: returns true when every character of
 * `needle` appears in `haystack` in order (gaps allowed). Used by the
 * global filter and by per-column string filters.
 */
function subsequenceMatch(haystack: string, needle: string): boolean {
  if (needle === '') return true;
  let h = 0;
  for (let n = 0; n < needle.length; n++) {
    const ch = needle.charCodeAt(n);
    while (h < haystack.length && haystack.charCodeAt(h) !== ch) h++;
    if (h >= haystack.length) return false;
    h++;
  }
  return true;
}

function readStoredVisibility(storageKey: string | null | undefined): string[] | null {
  if (!storageKey) return null;
  try {
    const raw = localStorage.getItem(`tableviz:${storageKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

function placeholderFor(c: ReportColumn): string {
  switch (c.type) {
    case 'cents':
      return '>100, <50, 100..500';
    case 'number':
    case 'pct':
      return '>10, 5..20';
    case 'date':
      return '>2026-01-01, 2026-01..2026-06';
    default:
      return 'fuzzy…';
  }
}

type Predicate = (raw: unknown, row: Record<string, unknown>) => boolean;

function buildPredicate(
  col: ReportColumn,
  raw: string,
  formatCell: (col: ReportColumn, raw: unknown) => string,
): Predicate | null {
  const expr = raw.trim();
  if (expr === '') return null;

  if (col.type === 'string') {
    const needle = expr.toLowerCase();
    return (cell) => {
      const s = formatCell(col, cell).toLowerCase();
      // Substring is a hit; otherwise fall through to subsequence so
      // a user can type "gth" and find "Groceries Total Health".
      return s.includes(needle) || subsequenceMatch(s, needle);
    };
  }

  if (col.type === 'date') {
    const cmp = parseComparison(expr);
    const range = parseRange(expr);
    if (range) {
      const [lo, hi] = range;
      return (cell) => {
        const s = (cell == null ? '' : String(cell)).slice(0, 10);
        return s >= lo && s <= hi;
      };
    }
    if (cmp) {
      const { op, value } = cmp;
      return (cell) => {
        const s = (cell == null ? '' : String(cell)).slice(0, 10);
        return compareString(s, op, value);
      };
    }
    // Fallback: substring on formatted display.
    const needle = expr.toLowerCase();
    return (cell) => formatCell(col, cell).toLowerCase().includes(needle);
  }

  // Numeric, cents, pct.
  const isCents = col.type === 'cents';
  const cmp = parseComparison(expr);
  const range = parseRange(expr);
  if (range) {
    const [lo, hi] = range.map(Number);
    if (Number.isNaN(lo) || Number.isNaN(hi)) {
      return substringPredicate(col, expr, formatCell);
    }
    return (cell) => {
      const n = toNumber(cell, isCents);
      return n !== null && n >= lo! && n <= hi!;
    };
  }
  if (cmp) {
    const target = Number(cmp.value);
    if (Number.isNaN(target)) {
      return substringPredicate(col, expr, formatCell);
    }
    return (cell) => {
      const n = toNumber(cell, isCents);
      return n !== null && compareNumber(n, cmp.op, target);
    };
  }
  return substringPredicate(col, expr, formatCell);
}

function substringPredicate(
  col: ReportColumn,
  expr: string,
  formatCell: (col: ReportColumn, raw: unknown) => string,
): Predicate {
  const needle = expr.toLowerCase();
  return (cell) => formatCell(col, cell).toLowerCase().includes(needle);
}

/**
 * For cents columns, cell values are integer cents but the user types
 * dollars. Multiply the user's number by 100 to align. We do this by
 * dividing the cell value by 100 before comparing — same effect, keeps
 * the cents column's negative-for-outflow sign in play.
 */
function toNumber(cell: unknown, isCents: boolean): number | null {
  if (cell == null) return null;
  const n = typeof cell === 'number' ? cell : Number(cell);
  if (Number.isNaN(n)) return null;
  return isCents ? n / 100 : n;
}

interface Comparison {
  op: '>' | '<' | '>=' | '<=' | '=';
  value: string;
}

function parseComparison(expr: string): Comparison | null {
  const m = expr.match(/^(>=|<=|=|>|<)\s*(.+)$/);
  if (!m) return null;
  return { op: m[1] as Comparison['op'], value: m[2]!.trim() };
}

function parseRange(expr: string): [string, string] | null {
  const m = expr.match(/^(.+?)\.\.(.+)$/);
  if (!m) return null;
  return [m[1]!.trim(), m[2]!.trim()];
}

function compareNumber(actual: number, op: Comparison['op'], target: number): boolean {
  switch (op) {
    case '>': return actual > target;
    case '<': return actual < target;
    case '>=': return actual >= target;
    case '<=': return actual <= target;
    case '=': return actual === target;
  }
}
function compareString(actual: string, op: Comparison['op'], target: string): boolean {
  switch (op) {
    case '>': return actual > target;
    case '<': return actual < target;
    case '>=': return actual >= target;
    case '<=': return actual <= target;
    case '=': return actual === target;
  }
}
