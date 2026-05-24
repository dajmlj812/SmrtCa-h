import { useEffect, useMemo, useState } from 'react';
import {
  api,
  isUpgradeRequired,
  type CalendarMonthResponse,
  type Transaction,
} from '../api';
import { formatCents, formatDate } from '../format';
import { UpgradePrompt } from '../components/UpgradePrompt';

/**
 * Phase 9.3 (0.12.3) — Calendar budget view.
 *
 * Month grid that shows per-day spending + bill-due markers, plus
 * a month summary card with spend / income / budget / pace. Clicking
 * a day pulls that day's transactions on demand and shows them in a
 * side drawer.
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
  // Avoid Date's local-vs-UTC mess by doing the math manually.
  let nm = (m ?? 1) + delta;
  let ny = y ?? new Date().getUTCFullYear();
  while (nm < 1) {
    nm += 12;
    ny -= 1;
  }
  while (nm > 12) {
    nm -= 12;
    ny += 1;
  }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function CalendarPage() {
  const [monthKey, setMonthKey] = useState<string>(currentMonthKey());
  const [data, setData] = useState<CalendarMonthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayTxns, setDayTxns] = useState<Transaction[]>([]);
  const [needsUpgrade, setNeedsUpgrade] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNeedsUpgrade(false);
    api
      .calendarMonth(monthKey)
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
  }, [monthKey]);

  async function loadDayTxns(date: string) {
    setSelectedDay(date);
    try {
      const r = await api.listTransactions({
        startDate: date,
        endDate: date,
        limit: 100,
      });
      setDayTxns(r.transactions);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load day');
    }
  }

  // First-of-month weekday for the grid layout.
  const firstWeekday = useMemo(() => {
    if (!data) return 0;
    // Day-of-week for the YYYY-MM-01 date, in UTC. Sunday = 0.
    const d = new Date(data.monthStart + 'T00:00:00Z');
    return d.getUTCDay();
  }, [data]);

  const maxSpend = useMemo(() => {
    if (!data) return 0;
    return data.days.reduce((m, d) => Math.max(m, d.spend_cents), 0);
  }, [data]);

  const pace = useMemo(() => {
    if (!data || data.totals.today_position === null) return null;
    // Spent / Budgeted vs. Day-of-month / DaysInMonth. 1.0 = on pace,
    // > 1.0 = ahead of schedule (over-spending), < 1.0 = under.
    if (data.totals.budget_cents === 0) return null;
    const spentPct = data.totals.spend_cents / data.totals.budget_cents;
    return spentPct / data.totals.today_position;
  }, [data]);

  // Build the grid: leading blanks (Sun-aligned) + days.
  const cells = useMemo(() => {
    if (!data) return [];
    const out: Array<{ kind: 'blank' } | { kind: 'day'; idx: number }> = [];
    for (let i = 0; i < firstWeekday; i++) out.push({ kind: 'blank' });
    for (let i = 0; i < data.daysInMonth; i++) out.push({ kind: 'day', idx: i });
    while (out.length % 7 !== 0) out.push({ kind: 'blank' });
    return out;
  }, [data, firstWeekday]);

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
            Per-day spending with bill-due markers + month pace.
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

      {error && <div className="banner error">{error}</div>}
      {loading && <p className="empty">Loading…</p>}

      {data && (
        <>
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <SummaryCard
              label={`${MONTH_LABELS[data.month - 1]} ${data.year} — spent`}
              value={formatCents(-data.totals.spend_cents)}
              tone="neg"
            />
            <SummaryCard
              label="Income"
              value={formatCents(data.totals.income_cents)}
              tone="pos"
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
                pace === null
                  ? '—'
                  : `${(pace * 100).toFixed(0)}% of budget pace`
              }
              tone={pace !== null && pace > 1.0 ? 'neg' : 'pos'}
            />
          </div>

          <div className="calendar-grid">
            {WEEKDAYS_SHORT.map((d) => (
              <div key={d} className="calendar-weekday">
                {d}
              </div>
            ))}
            {cells.map((c, i) => {
              if (c.kind === 'blank') return <div key={i} className="calendar-blank" />;
              const day = data.days[c.idx]!;
              const intensity =
                maxSpend > 0 ? Math.min(1, day.spend_cents / maxSpend) : 0;
              const isSelected = day.date === selectedDay;
              return (
                <button
                  key={day.date}
                  className={`calendar-day ${isSelected ? 'selected' : ''}`}
                  onClick={() => void loadDayTxns(day.date)}
                  style={
                    {
                      // Intensity-driven background, behind a translucent surface.
                      '--day-intensity': intensity.toFixed(2),
                    } as React.CSSProperties
                  }
                >
                  <div className="calendar-day-head">
                    <span className="calendar-day-num">
                      {Number(day.date.slice(-2))}
                    </span>
                    {day.bill_due_ids.length > 0 && (
                      <span
                        className="calendar-bill-marker"
                        title={`${day.bill_due_ids.length} bill(s) due`}
                      >
                        ▲
                      </span>
                    )}
                  </div>
                  {day.spend_cents > 0 && (
                    <div className="calendar-spend">
                      {formatCents(-day.spend_cents)}
                    </div>
                  )}
                  {day.txn_count > 1 && (
                    <div className="calendar-count muted">
                      {day.txn_count} txns
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {data.upcoming_bills.length > 0 && (
            <>
              <h2 style={{ marginTop: 24 }}>Upcoming bills (next 14 days)</h2>
              <div className="table-wrap">
                <table className="txn-table">
                  <thead>
                    <tr>
                      <th>Due</th>
                      <th>Name</th>
                      <th>Frequency</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.upcoming_bills.map((b) => (
                      <tr key={b.id}>
                        <td className="nowrap">{formatDate(b.next_due_date)}</td>
                        <td>{b.name}</td>
                        <td>{b.frequency}</td>
                        <td className="num">{formatCents(-b.amount_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {selectedDay && (
            <>
              <h2 style={{ marginTop: 24 }}>{formatDate(selectedDay)}</h2>
              {dayTxns.length === 0 ? (
                <p className="empty">No transactions on this day.</p>
              ) : (
                <div className="table-wrap">
                  <table className="txn-table">
                    <thead>
                      <tr>
                        <th>Description</th>
                        <th>Category</th>
                        <th className="num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dayTxns.map((t) => (
                        <tr key={t.id}>
                          <td>{t.normalized_merchant ?? t.raw_description}</td>
                          <td>
                            {t.category_name ?? <span className="muted">—</span>}
                          </td>
                          <td className={`num ${t.amount_cents < 0 ? 'neg' : 'pos'}`}>
                            {formatCents(t.amount_cents)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'pos' | 'neg';
}) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 13 }}>
        {label}
      </div>
      <div
        style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}
        className={tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : ''}
      >
        {value}
      </div>
    </div>
  );
}
