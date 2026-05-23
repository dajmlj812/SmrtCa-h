import { useEffect, useState } from 'react';
import { api, type TaxYearReport } from '../api';
import { formatCents } from '../format';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .taxYearReport(year)
      .then((r) => !cancelled && setReport(r))
      .catch(
        (e) => !cancelled && setError(e instanceof Error ? e.message : 'Load failed'),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [year]);

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
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading && !report && <p className="empty">Loading…</p>}

      {report && (
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
