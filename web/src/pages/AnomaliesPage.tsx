import { useEffect, useState } from 'react';
import { api, type AnomalyKind, type AnomalyRow } from '../api';
import { formatCents, formatDate } from '../format';

/**
 * Backlog (0.13.2) — Anomaly review page.
 *
 * Lists open alerts grouped by kind. "Dismiss" toggles the row.
 * "Run scan now" forces a fresh sweep of all transactions; the
 * detector also runs automatically after every import.
 */

const KIND_LABEL: Record<AnomalyKind, string> = {
  large_amount: 'Large amount',
  unusual_at_merchant: 'Unusual at merchant',
  duplicate_suspect: 'Possible duplicate',
};

export function AnomaliesPage() {
  const [anomalies, setAnomalies] = useState<AnomalyRow[]>([]);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setAnomalies(await api.listAnomalies(includeDismissed));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [includeDismissed]);

  async function scan() {
    setBusy('scan');
    setError(null);
    setInfo(null);
    try {
      const r = await api.scanAnomalies();
      if (!r.enabled) {
        setInfo(
          'Anomaly detection is disabled. Ask a super admin to turn on ANOMALY_ENABLED in Settings.',
        );
      } else {
        setInfo(
          `Scanned ${r.scanned} transaction${r.scanned === 1 ? '' : 's'} — ${
            r.newAlerts
          } new alert${r.newAlerts === 1 ? '' : 's'}.`,
        );
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setBusy(null);
    }
  }

  async function toggleDismiss(a: AnomalyRow) {
    setBusy(`d-${a.id}`);
    try {
      await api.dismissAnomaly(a.id, !a.dismissed);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dismiss failed');
    } finally {
      setBusy(null);
    }
  }

  // Group by kind for the panel layout.
  const byKind = anomalies.reduce<Record<string, AnomalyRow[]>>((acc, a) => {
    (acc[a.kind] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Anomalies</h1>
          <div className="subtitle">
            Unusual transactions flagged by the detector: large single
            charges, outliers vs. your normal at a merchant, and
            likely double-charges.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={includeDismissed}
              onChange={(e) => setIncludeDismissed(e.target.checked)}
            />{' '}
            Include dismissed
          </label>
          <button className="btn" onClick={() => void scan()} disabled={busy !== null}>
            {busy === 'scan' ? 'Scanning…' : 'Run scan now'}
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}
      {loading && <p className="empty">Loading…</p>}

      {!loading && anomalies.length === 0 && (
        <p className="empty">
          No anomalies right now. {includeDismissed ? '' : 'Check "Include dismissed" to see ones you\'ve already cleared.'}
        </p>
      )}

      {(['large_amount', 'unusual_at_merchant', 'duplicate_suspect'] as AnomalyKind[]).map(
        (kind) =>
          byKind[kind] && byKind[kind]!.length > 0 ? (
            <div key={kind} style={{ marginTop: 16 }}>
              <h2>
                {KIND_LABEL[kind]}{' '}
                <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>
                  ({byKind[kind]!.length})
                </span>
              </h2>
              <div className="table-wrap">
                <table className="txn-table">
                  <thead>
                    <tr>
                      <th>Detected</th>
                      <th>Txn date</th>
                      <th>Description</th>
                      <th>Account</th>
                      <th className="num">Amount</th>
                      <th>Severity</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {byKind[kind]!.map((a) => (
                      <tr key={a.id} className={a.dismissed ? 'row-dismissed' : ''}>
                        <td className="nowrap">{formatDate(a.detected_at)}</td>
                        <td className="nowrap">{formatDate(a.txn_date)}</td>
                        <td>
                          <div>
                            {a.normalized_merchant ?? a.raw_description}
                          </div>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {a.message}
                          </div>
                        </td>
                        <td>{a.account_name}</td>
                        <td
                          className={`num ${
                            a.txn_amount_cents < 0 ? 'neg' : 'pos'
                          }`}
                        >
                          {formatCents(a.txn_amount_cents)}
                        </td>
                        <td>
                          <span
                            className={
                              a.severity === 'high'
                                ? 'pill neg'
                                : a.severity === 'warn'
                                ? 'pill'
                                : 'pill muted'
                            }
                          >
                            {a.severity}
                          </span>
                        </td>
                        <td>
                          <button
                            className="btn small secondary"
                            onClick={() => void toggleDismiss(a)}
                            disabled={busy === `d-${a.id}`}
                          >
                            {a.dismissed ? 'Re-open' : 'Dismiss'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null,
      )}
    </div>
  );
}
