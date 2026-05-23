import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type ReportColumn,
  type ReportDef,
  type ReportResult,
} from '../api';
import { formatCents } from '../format';

function formatCell(col: ReportColumn, raw: unknown): string {
  if (raw === null || raw === undefined) return '—';
  switch (col.type) {
    case 'cents': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      return formatCents(n);
    }
    case 'pct':
      return `${(Number(raw) * 100).toFixed(1)}%`;
    case 'number':
      return Number(raw).toLocaleString();
    case 'date':
    case 'string':
    default:
      return String(raw);
  }
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function downloadCsv(label: string, result: ReportResult): void {
  const header = result.columns.map((c) => csvCell(c.label)).join(',');
  const lines = result.rows.map((row) =>
    result.columns
      .map((c) => csvCell(formatCell(c, row[c.key])))
      .join(','),
  );
  const blob = new Blob([[header, ...lines].join('\r\n') + '\r\n'], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const today = new Date().toISOString().slice(0, 10);
  a.download = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${today}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  const [reports, setReports] = useState<ReportDef[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ReportResult | null>(null);
  const [resultLabel, setResultLabel] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listReports()
      .then((list) => {
        setReports(list);
        if (list.length > 0) {
          setActiveId(list[0]!.id);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Load failed'))
      .finally(() => setLoading(false));
  }, []);

  const active = reports.find((r) => r.id === activeId) ?? null;

  useEffect(() => {
    if (!active) return;
    const defaults: Record<string, string> = {};
    for (const p of active.params) {
      if (p.default !== undefined) defaults[p.name] = p.default;
    }
    setParams(defaults);
    setResult(null);
    setResultLabel('');
  }, [activeId]);

  async function runActive(e: FormEvent) {
    e.preventDefault();
    if (!active) return;
    setRunning(true);
    setError(null);
    try {
      const r = await api.runReport(active.id, params);
      setResult(r.result);
      setResultLabel(r.label);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <div className="subtitle">
            Canned reports for common questions. Natural-language AI-driven
            reports are coming in a later release.
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading ? (
        <p className="empty">Loading…</p>
      ) : (
        <div className="reports-layout">
          <aside className="reports-list">
            {reports.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`reports-list-item ${r.id === activeId ? 'active' : ''}`}
                onClick={() => setActiveId(r.id)}
              >
                <strong>{r.label}</strong>
                <span className="muted">{r.description}</span>
              </button>
            ))}
          </aside>

          <section className="reports-detail">
            {active ? (
              <>
                <h2 style={{ marginTop: 0 }}>{active.label}</h2>
                <p className="muted">{active.description}</p>
                <form onSubmit={runActive} className="card" style={{ padding: 12 }}>
                  {active.params.length === 0 && (
                    <p className="muted" style={{ margin: '4px 0 8px' }}>
                      No parameters.
                    </p>
                  )}
                  {active.params.length > 0 && (
                    <div className="form-grid">
                      {active.params.map((p) => (
                        <div className="field" key={p.name}>
                          <label htmlFor={`rp-${p.name}`}>{p.label}</label>
                          <input
                            id={`rp-${p.name}`}
                            type={p.type === 'date' ? 'date' : p.type === 'int' ? 'number' : 'text'}
                            value={params[p.name] ?? ''}
                            onChange={(e) =>
                              setParams((prev) => ({
                                ...prev,
                                [p.name]: e.target.value,
                              }))
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                    <button className="btn" type="submit" disabled={running}>
                      {running ? 'Running…' : 'Run report'}
                    </button>
                    {result && (
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => downloadCsv(resultLabel || active.label, result)}
                      >
                        Export CSV
                      </button>
                    )}
                  </div>
                </form>

                {result && (
                  <div className="page-section">
                    {result.summary && (
                      <div className="muted" style={{ marginBottom: 8 }}>
                        {result.summary}
                      </div>
                    )}
                    {result.rows.length === 0 ? (
                      <p className="empty">
                        No data for that range. Adjust the parameters and try
                        again.
                      </p>
                    ) : (
                      <div className="table-wrap">
                        <table className="txn-table">
                          <thead>
                            <tr>
                              {result.columns.map((c) => (
                                <th
                                  key={c.key}
                                  className={c.type === 'cents' || c.type === 'number' || c.type === 'pct' ? 'num' : ''}
                                >
                                  {c.label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {result.rows.map((row, i) => (
                              <tr key={i}>
                                {result.columns.map((c) => (
                                  <td
                                    key={c.key}
                                    className={
                                      c.type === 'cents' || c.type === 'number' || c.type === 'pct'
                                        ? 'num'
                                        : ''
                                    }
                                  >
                                    {formatCell(c, row[c.key])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="empty">Pick a report on the left to begin.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
