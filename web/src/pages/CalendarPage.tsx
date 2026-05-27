import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  api,
  isUpgradeRequired,
  type Account,
  type CalendarMonthResponse,
  type Category,
  type Transaction,
} from '../api';
import { formatCents, formatDate } from '../format';
import { TransactionTable } from '../components/TransactionTable';
import { AttachmentsModal } from '../components/AttachmentsModal';
import { RefundStatusModal } from '../components/RefundStatusModal';
import { SplitsModal } from '../components/SplitsModal';
import { UpgradePrompt } from '../components/UpgradePrompt';

/**
 * Phase 9.3 (0.12.3) + 0.21.x — Calendar budget view.
 *
 * Month grid that shows per-day spend / income / bill-due, plus a
 * month summary card and an upcoming-activity window combining
 * bills (expense) and recurring income.
 *
 * 0.21.x additions:
 *   • Account multi-select filter; aggregates and budget total
 *     scope to the picked accounts.
 *   • Inline day expansion: click a day to expand the cell in
 *     place with its bills + transactions; "Expand all" toggles
 *     every day at once.
 *   • Past / present / future days render identically — bills due
 *     and totals always show, no special chrome for "today".
 *   • Selected-day detail moves above the upcoming list.
 *   • Upcoming window: user picks count + unit (days/weeks/months).
 *   • Amounts colored by direction (income green, expense red).
 */

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function currentMonthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map((s) => Number(s));
  let nm = (m ?? 1) + delta;
  let ny = y ?? new Date().getUTCFullYear();
  while (nm < 1) { nm += 12; ny -= 1; }
  while (nm > 12) { nm -= 12; ny += 1; }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

type UpcomingUnit = 'day' | 'week' | 'month';

function unitToDays(count: number, unit: UpcomingUnit): number {
  if (unit === 'day') return count;
  if (unit === 'week') return count * 7;
  return count * 30;
}

export function CalendarPage() {
  const [monthKey, setMonthKey] = useState<string>(currentMonthKey());
  const [data, setData] = useState<CalendarMonthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayTxns, setDayTxns] = useState<Transaction[]>([]);
  const [needsUpgrade, setNeedsUpgrade] = useState(false);

  // 0.21.x — account multi-select
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);

  // 0.21.x — inline day expansion
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const allExpanded =
    data != null && data.days.length > 0 && expandedDays.size === data.days.length;

  // 0.21.x — upcoming window
  const [upcomingCount, setUpcomingCount] = useState<number>(14);
  const [upcomingUnit, setUpcomingUnit] = useState<UpcomingUnit>('day');
  const upcomingDays = unitToDays(upcomingCount, upcomingUnit);

  // 0.21.x — compare to last month
  const [compareToPrev, setCompareToPrev] = useState(false);
  const [prevData, setPrevData] = useState<CalendarMonthResponse | null>(null);

  // 0.21.x — categories + transaction action modals
  const [categories, setCategories] = useState<Category[]>([]);
  const [attachmentsFor, setAttachmentsFor] = useState<Transaction | null>(null);
  const [splittingFor, setSplittingFor] = useState<Transaction | null>(null);
  const [refundingFor, setRefundingFor] = useState<Transaction | null>(null);

  useEffect(() => {
    void api.listAccounts().then(setAccounts).catch(() => undefined);
    void api.listCategories().then(setCategories).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNeedsUpgrade(false);
    api
      .calendarMonth(monthKey, {
        accountIds: selectedAccountIds,
        upcomingDays,
      })
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (isUpgradeRequired(e)) {
          setNeedsUpgrade(true);
        } else {
          setError(e instanceof Error ? e.message : 'Failed to load month');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [monthKey, selectedAccountIds, upcomingDays]);

  // 0.21.x — fetch previous month when compare is on.
  useEffect(() => {
    if (!compareToPrev) {
      setPrevData(null);
      return;
    }
    const prevKey = shiftMonth(monthKey, -1);
    let cancelled = false;
    void api
      .calendarMonth(prevKey, { accountIds: selectedAccountIds })
      .then((r) => {
        if (!cancelled) setPrevData(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [compareToPrev, monthKey, selectedAccountIds]);

  // Whenever the selected day changes, load that day's transactions.
  // Same filter (selectedAccountIds) so the drill-down stays
  // consistent with the calendar aggregates.
  useEffect(() => {
    if (!selectedDay) {
      setDayTxns([]);
      return;
    }
    let cancelled = false;
    void api
      .listTransactions({
        startDate: selectedDay,
        endDate: selectedDay,
        limit: 200,
      })
      .then((r) => {
        if (cancelled) return;
        const filtered =
          selectedAccountIds.length === 0
            ? r.transactions
            : r.transactions.filter((t) => selectedAccountIds.includes(t.account_id));
        setDayTxns(filtered);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedDay, selectedAccountIds]);

  const firstWeekday = useMemo(() => {
    if (!data) return 0;
    const d = new Date(data.monthStart + 'T00:00:00Z');
    return d.getUTCDay();
  }, [data]);

  const maxSpend = useMemo(() => {
    if (!data) return 0;
    return data.days.reduce((m, d) => Math.max(m, d.spend_cents), 0);
  }, [data]);

  const pace = useMemo(() => {
    if (!data || data.totals.today_position === null) return null;
    if (data.totals.budget_cents === 0) return null;
    const spentPct = data.totals.spend_cents / data.totals.budget_cents;
    return spentPct / data.totals.today_position;
  }, [data]);

  const cells = useMemo(() => {
    if (!data) return [];
    const out: Array<{ kind: 'blank' } | { kind: 'day'; idx: number }> = [];
    for (let i = 0; i < firstWeekday; i++) out.push({ kind: 'blank' });
    for (let i = 0; i < data.daysInMonth; i++) out.push({ kind: 'day', idx: i });
    while (out.length % 7 !== 0) out.push({ kind: 'blank' });
    return out;
  }, [data, firstWeekday]);

  function toggleAccount(id: string) {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function toggleDay(date: string) {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
    setSelectedDay(date);
  }

  function toggleExpandAll() {
    if (!data) return;
    if (allExpanded) {
      setExpandedDays(new Set());
    } else {
      setExpandedDays(new Set(data.days.map((d) => d.date)));
    }
  }

  if (needsUpgrade) {
    return (
      <div>
        <div className="page-header"><h1>Calendar</h1></div>
        <UpgradePrompt feature="Calendar budget view" requiredPlan="plus" />
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Calendar</h1>
          <div className="subtitle">
            Per-day spend + bills due, with month pace. Click a day
            to expand inline.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn secondary"
            onClick={() => setMonthKey(shiftMonth(monthKey, -1))}
          >
            ← Prev
          </button>
          <button
            className="btn secondary"
            onClick={() => setMonthKey(currentMonthKey())}
          >
            Today
          </button>
          <button
            className="btn secondary"
            onClick={() => setMonthKey(shiftMonth(monthKey, 1))}
          >
            Next →
          </button>
        </div>
      </div>

      {/* 0.21.x — account filter chips */}
      {accounts.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ marginTop: 0 }}>
            Accounts ({selectedAccountIds.length === 0 ? 'all' : `${selectedAccountIds.length} selected`})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {accounts.map((a) => {
              const on = selectedAccountIds.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`pill ${on ? 'pos' : ''}`}
                  style={{ cursor: 'pointer', border: 0 }}
                  onClick={() => toggleAccount(a.id)}
                >
                  {on ? '✓ ' : ''}{a.name}
                </button>
              );
            })}
            {selectedAccountIds.length > 0 && (
              <button
                type="button"
                className="btn-link"
                onClick={() => setSelectedAccountIds([])}
              >
                Clear
              </button>
            )}
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            Filters transactions, bills, and the budget total. Budgets
            with no account scope still apply.
          </div>
        </div>
      )}

      {error && <div className="banner error">{error}</div>}
      {loading && !data && <p className="empty">Loading…</p>}

      {data && (
        <>
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <SummaryCard
              label={`${MONTH_LABELS[data.month - 1]} ${data.year} — spent`}
              value={formatCents(-data.totals.spend_cents)}
              tone="neg"
              delta={
                prevData
                  ? deltaPct(data.totals.spend_cents, prevData.totals.spend_cents)
                  : null
              }
              deltaTone="lower-is-good"
            />
            <SummaryCard
              label="Income"
              value={formatCents(data.totals.income_cents)}
              tone="pos"
              delta={
                prevData
                  ? deltaPct(data.totals.income_cents, prevData.totals.income_cents)
                  : null
              }
              deltaTone="higher-is-good"
            />
            <SummaryCard
              label="Budgeted"
              value={
                data.totals.budget_cents > 0
                  ? formatCents(-data.totals.budget_cents)
                  : '—'
              }
            />
            <SummaryCard
              label="Pace"
              value={
                pace === null ? '—' : `${(pace * 100).toFixed(0)}% of budget pace`
              }
              tone={pace !== null && pace > 1.0 ? 'neg' : 'pos'}
              footnote={
                data.totals.budget_cents > 0
                  ? 'Based on Monthly budget targets'
                  : 'No Monthly budget set'
              }
            />
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              margin: '12px 0',
              gap: 12,
            }}
          >
            <label className="muted small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={compareToPrev}
                onChange={(e) => setCompareToPrev(e.target.checked)}
              />
              Compare to last month
            </label>
            <button
              className="btn secondary"
              type="button"
              onClick={toggleExpandAll}
            >
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          </div>

          <div className="calendar-grid">
            {WEEKDAYS_SHORT.map((d) => (
              <div key={d} className="calendar-weekday">{d}</div>
            ))}
            {cells.map((c, i) => {
              if (c.kind === 'blank') {
                return <div key={i} className="calendar-blank" />;
              }
              const day = data.days[c.idx]!;
              const intensity =
                maxSpend > 0 ? Math.min(1, day.spend_cents / maxSpend) : 0;
              const isExpanded = expandedDays.has(day.date);
              const isSelected = day.date === selectedDay;
              const billsTotal = day.bills_due.reduce(
                (s, b) => s + b.amount_cents,
                0,
              );
              return (
                <button
                  key={day.date}
                  className={`calendar-day ${isSelected ? 'selected' : ''} ${isExpanded ? 'expanded' : ''}`}
                  onClick={() => toggleDay(day.date)}
                  style={{
                    '--day-intensity': intensity.toFixed(2),
                  } as CSSProperties}
                >
                  <div className="calendar-day-head">
                    <span className="calendar-day-num">
                      {Number(day.date.slice(-2))}
                    </span>
                    {day.bills_due.length > 0 && (
                      <span
                        className="calendar-bill-marker"
                        title={`${day.bills_due.length} bill(s) due`}
                      >
                        ▲ {day.bills_due.length}
                      </span>
                    )}
                  </div>
                  {day.spend_cents > 0 && (
                    <div className="calendar-spend neg">
                      {formatCents(-day.spend_cents)}
                    </div>
                  )}
                  {day.income_cents > 0 && (
                    <div className="calendar-income pos">
                      +{formatCents(day.income_cents)}
                    </div>
                  )}
                  {billsTotal > 0 && (
                    <div className="calendar-bill-total neg">
                      Bills: {formatCents(-billsTotal)}
                    </div>
                  )}
                  {day.txn_count > 1 && !isExpanded && (
                    <div className="calendar-count muted">
                      {day.txn_count} txns
                    </div>
                  )}
                  {isExpanded && (
                    <div
                      className="calendar-day-detail"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {day.bills_due.length > 0 && (
                        <>
                          <div className="muted small">Bills due</div>
                          {day.bills_due.map((b) => (
                            <div key={b.id} className="calendar-detail-row">
                              <span>{b.name}</span>
                              <span className="num neg">
                                {formatCents(-b.amount_cents)}
                              </span>
                            </div>
                          ))}
                        </>
                      )}
                      {day.spend_cents === 0
                        && day.income_cents === 0
                        && day.bills_due.length === 0 && (
                        <div className="muted small">No activity</div>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* 0.21.x — selected-day transactions ABOVE upcoming list.
              Uses the full TransactionTable so the user can open
              attachments / splits / refund-status modals directly
              from a calendar drilldown. */}
          {selectedDay && (
            <>
              <h2 style={{ marginTop: 24 }}>{formatDate(selectedDay)}</h2>
              {dayTxns.length === 0 ? (
                <p className="empty">No transactions on this day.</p>
              ) : (
                <TransactionTable
                  transactions={dayTxns}
                  showAccount
                  categories={categories}
                  onUpdate={async (id, updates) => {
                    const updated = await api.updateTransaction(id, updates);
                    setDayTxns((prev) =>
                      prev.map((t) => (t.id === id ? updated : t)),
                    );
                  }}
                  onOpenAttachments={setAttachmentsFor}
                  onOpenSplits={setSplittingFor}
                  onOpenRefund={setRefundingFor}
                />
              )}
            </>
          )}

          {attachmentsFor && (
            <AttachmentsModal
              transaction={attachmentsFor}
              onClose={() => setAttachmentsFor(null)}
              onCountChange={(count) =>
                setDayTxns((prev) =>
                  prev.map((t) =>
                    t.id === attachmentsFor.id
                      ? { ...t, attachment_count: count }
                      : t,
                  ),
                )
              }
            />
          )}
          {splittingFor && (
            <SplitsModal
              transaction={splittingFor}
              categories={categories}
              onClose={() => setSplittingFor(null)}
              onSaved={() => setSplittingFor(null)}
            />
          )}
          {refundingFor && (
            <RefundStatusModal
              transaction={refundingFor}
              onClose={() => setRefundingFor(null)}
              onSaved={(updated) =>
                setDayTxns((prev) =>
                  prev.map((t) => (t.id === updated.id ? updated : t)),
                )
              }
            />
          )}

          {/* 0.21.x — upcoming activity with selectable window */}
          <div
            style={{
              marginTop: 24,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <h2 style={{ margin: 0 }}>Upcoming activity</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Next</label>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={upcomingCount}
                  onChange={(e) =>
                    setUpcomingCount(Math.max(1, Number(e.target.value) || 1))
                  }
                  style={{ width: 80 }}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>&nbsp;</label>
                <select
                  value={upcomingUnit}
                  onChange={(e) => setUpcomingUnit(e.target.value as UpcomingUnit)}
                >
                  <option value="day">Day(s)</option>
                  <option value="week">Week(s)</option>
                  <option value="month">Month(s)</option>
                </select>
              </div>
            </div>
          </div>
          {data.upcoming.length === 0 ? (
            <p className="empty">
              Nothing in the next {upcomingCount} {upcomingUnit}
              {upcomingCount === 1 ? '' : 's'}.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="txn-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Frequency</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.upcoming.map((u) => (
                    <tr key={`${u.direction}-${u.id}-${u.date}`}>
                      <td className="nowrap">{formatDate(u.date)}</td>
                      <td>{u.name}</td>
                      <td>
                        <span className={`pill ${u.direction === 'income' ? 'pos' : 'neg'}`}>
                          {u.direction === 'income' ? 'Income' : 'Bill'}
                        </span>
                      </td>
                      <td className="muted small">{u.frequency ?? '—'}</td>
                      <td className={`num ${u.direction === 'income' ? 'pos' : 'neg'}`}>
                        {u.direction === 'income' ? '+' : '−'}
                        {formatCents(u.amount_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) {
    if (current === 0) return 0;
    return null;
  }
  return (current - previous) / Math.abs(previous);
}

function SummaryCard({
  label,
  value,
  tone,
  delta,
  deltaTone,
  footnote,
}: {
  label: string;
  value: string;
  tone?: 'pos' | 'neg';
  /** Fractional delta vs prior month (0.10 = +10%). */
  delta?: number | null;
  /** Direction that's "good" — used to colour the delta. */
  deltaTone?: 'lower-is-good' | 'higher-is-good';
  footnote?: string;
}) {
  let deltaText: string | null = null;
  let deltaClass = '';
  if (delta !== null && delta !== undefined) {
    const sign = delta > 0 ? '+' : '';
    deltaText = `${sign}${(delta * 100).toFixed(0)}% vs last month`;
    if (deltaTone) {
      const good =
        (deltaTone === 'lower-is-good' && delta <= 0) ||
        (deltaTone === 'higher-is-good' && delta >= 0);
      deltaClass = good ? 'pos' : 'neg';
    }
  }
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 13 }}>{label}</div>
      <div
        style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}
        className={tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : ''}
      >
        {value}
      </div>
      {deltaText && (
        <div className={`small ${deltaClass}`} style={{ marginTop: 4 }}>
          {deltaText}
        </div>
      )}
      {footnote && (
        <div className="muted small" style={{ marginTop: 4 }}>
          {footnote}
        </div>
      )}
    </div>
  );
}
