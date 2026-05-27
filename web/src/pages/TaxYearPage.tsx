import { useEffect, useState } from 'react';
import {
  api,
  isUpgradeRequired,
  type ScheduleCReport,
  type TaxYearReport,
} from '../api';
import { formatCents } from '../format';
import { UpgradePrompt } from '../components/UpgradePrompt';

/**
 * Backlog (0.13.1) — year-end tax summary page.
 *
 * Year picker + a table grouped by tax_category, split into income
 * and deductible sections. Download-CSV button hits the server's
 * CSV endpoint directly (browser handles the file save).
 */
export function TaxYearPage() {
  const now = new Date();
  const [year, setYear] = useState<number>(now.getUTCFullYear());
  const [report, setReport] = useState<TaxYearReport | null>(null);
  const [scheduleC, setScheduleC] = useState<ScheduleCReport | null>(null);
  const [tab, setTab] = useState<'summary' | 'schedule-c'>('summary');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsUpgrade, setNeedsUpgrade] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNeedsUpgrade(false);
    Promise.all([
      api.taxYearReport(year),
      api.scheduleCReport(year).catch(() => null),
    ])
      .then(([r, sc]) => {
        if (cancelled) return;
        setReport(r);
        setScheduleC(sc);
      })
      .catch((e) => {
        if (cancelled) return;
        if (isUpgradeRequired(e)) {
          setNeedsUpgrade(true);
        } else {
          setError(e instanceof Error ? e.message : 'Load failed');
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [year]);

  if (needsUpgrade) {
    return (
      <div>
        <div className="page-header"><h1>Tax Year Summary</h1></div>
        <UpgradePrompt feature="Tax-year reports" requiredPlan="plus" />
      </div>
    );
  }

  // Build a list of recent years (this + last 5) plus the loaded one
  // if it's outside that range. Keeps the dropdown short + useful.
  const years: number[] = [];
  for (let y = now.getUTCFullYear(); y >= now.getUTCFullYear() - 5; y--) years.push(y);
  if (!years.includes(year)) years.unshift(year);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Tax Year Summary</h1>
          <div className="subtitle">
            Aggregates transactions whose category has a tax tag set.
            Tag categories on the <strong>Categories</strong> page; this
            page totals them by tax category. Transfers excluded.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor="tax-year">Year</label>
            <select
              id="tax-year"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <a
            href={api.taxYearCsvUrl(year)}
            className="btn secondary"
            download
          >
            Download CSV
          </a>
          <a
            href={api.taxYearTxfUrl(year)}
            className="btn secondary"
            download
            title="TurboTax-importable Tax eXchange Format"
          >
            Download TXF
          </a>
          <a
            href={api.mileageCsvUrl(year)}
            className="btn secondary"
            download
            title="Per-trip mileage log (IRS substantiation)"
          >
            Mileage CSV
          </a>
        </div>
      </div>

      <div className="tab-bar" style={{ marginTop: 12 }}>
        <button
          className={`tab ${tab === 'summary' ? 'active' : ''}`}
          type="button"
          onClick={() => setTab('summary')}
        >
          Summary
        </button>
        <button
          className={`tab ${tab === 'schedule-c' ? 'active' : ''}`}
          type="button"
          onClick={() => setTab('schedule-c')}
        >
          Schedule C
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading && !report && <p className="empty">Loading…</p>}

      {tab === 'schedule-c' && scheduleC && (
        <ScheduleCView report={scheduleC} />
      )}
      {tab === 'schedule-c' && !scheduleC && !loading && (
        <p className="empty" style={{ marginTop: 16 }}>
          Schedule C couldn't be loaded for {year}.
        </p>
      )}

      {tab === 'summary' && report && (
        <>
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <SummaryCard
              label={`Income (${report.year})`}
              value={formatCents(report.total_income_cents)}
              tone="pos"
            />
            <SummaryCard
              label="Deductible spending"
              value={formatCents(report.total_deductible_cents)}
              tone="neg"
            />
            <SummaryCard
              label="Tagged transactions"
              value={report.total_txn_count.toLocaleString()}
            />
          </div>

          {report.by_tax_category.length === 0 ? (
            <p className="empty" style={{ marginTop: 16 }}>
              No tagged transactions for {report.year}. Set a tax tag on a
              category to see it here.
            </p>
          ) : (
            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table className="txn-table">
                <thead>
                  <tr>
                    <th>Tax category</th>
                    <th>Type</th>
                    <th className="num">Total</th>
                    <th className="num">Txns</th>
                    <th>Contributing categories</th>
                  </tr>
                </thead>
                <tbody>
                  {report.by_tax_category.map((row, i) => (
                    <tr key={`${row.tax_category}-${row.sign}-${i}`}>
                      <td>
                        <strong>{row.tax_category}</strong>
                      </td>
                      <td>
                        <span
                          className={`pill ${row.sign === 'income' ? 'pos' : 'neg'}`}
                        >
                          {row.sign}
                        </span>
                      </td>
                      <td
                        className={`num ${
                          row.total_cents < 0 ? 'neg' : 'pos'
                        }`}
                      >
                        {formatCents(row.total_cents)}
                      </td>
                      <td className="num">{row.txn_count}</td>
                      <td className="muted" style={{ fontSize: 13 }}>
                        {row.contributing_categories.join(', ')}
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

function ScheduleCView({ report }: { report: ScheduleCReport }) {
  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <SummaryCard
          label="Gross receipts (Line 1)"
          value={formatCents(report.total_gross_receipts_cents)}
          tone="pos"
        />
        <SummaryCard
          label="Total expenses (Line 28)"
          value={formatCents(report.total_expenses_cents)}
          tone="neg"
        />
        <SummaryCard
          label="Net profit (Line 31)"
          value={formatCents(report.net_profit_cents)}
          tone={report.net_profit_cents >= 0 ? 'pos' : 'neg'}
        />
        <SummaryCard
          label="Business miles"
          value={`${report.mileage.business_miles.toFixed(1)} mi`}
        />
      </div>

      <div className="table-wrap" style={{ marginTop: 16 }}>
        <table className="txn-table">
          <thead>
            <tr>
              <th>Line</th>
              <th>Schedule C label</th>
              <th>Type</th>
              <th className="num">Amount</th>
              <th className="num">Txns</th>
              <th>Source tax_category labels</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No Schedule C activity for {report.year}. Tag categories
                  on the <strong>Categories</strong> page with Schedule C
                  line labels (e.g. "Schedule C - Line 8 Advertising").
                </td>
              </tr>
            )}
            {report.lines.map((row) => (
              <tr key={row.line}>
                <td><strong>{row.line}</strong></td>
                <td>{row.label}</td>
                <td>
                  <span className={`pill ${row.kind === 'income' ? 'pos' : 'neg'}`}>
                    {row.kind}
                  </span>
                </td>
                <td className={`num ${row.total_cents < 0 ? 'neg' : 'pos'}`}>
                  {formatCents(Math.abs(row.total_cents))}
                </td>
                <td className="num">{row.txn_count}</td>
                <td className="muted" style={{ fontSize: 13 }}>
                  {row.contributing_tax_categories.join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.unmatched.length > 0 && (
        <div className="banner warn" style={{ marginTop: 16 }}>
          <strong>{report.unmatched.length}</strong> tax_category label(s)
          didn't map to a Schedule C line and were excluded:{' '}
          {report.unmatched.map((u) => u.tax_category).join(', ')}.
          Rename them on the Categories page to match a Schedule C line
          (e.g. "Schedule C - Line 18 Office expense").
        </div>
      )}
    </>
  );
}
