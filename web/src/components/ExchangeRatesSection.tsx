import { useEffect, useState, type FormEvent } from 'react';
import { api, type ExchangeRate } from '../api';

/**
 * Super-admin FX rate management.
 *
 *  - Lists the latest rate per (from, to) pair.
 *  - "Refresh from provider" pulls fresh rates via open.er-api.com,
 *    inserting one row per non-base currency.
 *  - Manual override form lets the operator pin a rate when the auto
 *    feed is wrong or unavailable.
 *  - Display currency is read from the settings (DISPLAY_CURRENCY) and
 *    surfaced as the title.
 */
export function ExchangeRatesSection() {
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [display, setDisplay] = useState<string>('USD');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api.listExchangeRates();
      setRates(r.rates);
      setDisplay(r.display_currency);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load rates');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function refresh() {
    setBusy(true);
    setErr(null);
    setSuccess(null);
    try {
      const r = await api.refreshExchangeRates();
      setSuccess(
        `Pulled ${r.inserted} rate${r.inserted === 1 ? '' : 's'} for base ${r.base} at ${r.fetchedAt.slice(0, 19).replace('T', ' ')}.`,
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(from: string, to: string) {
    if (!window.confirm(`Drop all rows for ${from} → ${to}?`)) return;
    try {
      await api.deleteExchangeRate(from, to);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div className="page-section">
      <div className="page-section-head">
        <div>
          <h2>Exchange rates</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            Display currency: <code>{display}</code> · accounts in any other
            currency are summed using these rates on dashboards.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn secondary"
            type="button"
            onClick={() => setShowForm((s) => !s)}
          >
            {showForm ? 'Cancel' : 'Manual rate'}
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? 'Refreshing…' : 'Refresh from provider'}
          </button>
        </div>
      </div>

      {err && <div className="banner error">{err}</div>}
      {success && <div className="banner success">{success}</div>}
      {showForm && <ManualRateForm onSaved={() => { setShowForm(false); void load(); }} />}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : rates.length === 0 ? (
        <p className="empty">
          No rates configured. Click <strong>Refresh from provider</strong> to
          pull from open.er-api.com, or use <strong>Manual rate</strong> to set
          one by hand.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th className="num">Rate</th>
                <th>Source</th>
                <th>Fetched</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.from_currency}</code></td>
                  <td><code>{r.to_currency}</code></td>
                  <td className="num">{Number(r.rate).toFixed(6)}</td>
                  <td>
                    <span
                      className={`pill ${r.source === 'manual' ? 'status-alter-pill' : 'status-active-pill'}`}
                    >
                      {r.source}
                    </span>
                  </td>
                  <td className="nowrap">{r.fetched_at.slice(0, 19).replace('T', ' ')}</td>
                  <td>
                    <button
                      className="btn-link danger"
                      type="button"
                      onClick={() => void remove(r.from_currency, r.to_currency)}
                    >
                      Drop
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ManualRateForm({ onSaved }: { onSaved: () => void }) {
  const [from, setFrom] = useState('USD');
  const [to, setTo] = useState('EUR');
  const [rate, setRate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = Number(rate);
      await api.setExchangeRate({
        fromCurrency: from.toUpperCase(),
        toCurrency: to.toUpperCase(),
        rate: r,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ padding: 12, marginBottom: 12 }} onSubmit={submit}>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label>From (ISO)</label>
          <input
            type="text"
            maxLength={3}
            value={from}
            onChange={(e) => setFrom(e.target.value.toUpperCase())}
            required
          />
        </div>
        <div className="field">
          <label>To (ISO)</label>
          <input
            type="text"
            maxLength={3}
            value={to}
            onChange={(e) => setTo(e.target.value.toUpperCase())}
            required
          />
        </div>
        <div className="field">
          <label>Rate (1 unit of From in To)</label>
          <input
            type="number"
            step="0.0001"
            min="0.0001"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            required
          />
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save manual rate'}
        </button>
      </div>
    </form>
  );
}
