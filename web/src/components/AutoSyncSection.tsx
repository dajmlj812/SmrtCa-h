import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Phase 8.3 (0.11.3) — Auto-sync settings on the super-admin
 * /system page.
 *
 * The settings themselves are stored under the same KNOWN_SETTINGS
 * row mechanism as backups / SMTP / Plaid / etc. We update them via
 * the standard /api/settings PUT path. The "Run now" button forces
 * an immediate tick regardless of cadence — useful when wiring up
 * the first connection and watching it work.
 */

interface AutoSyncStatus {
  enabled: boolean;
  frequency: string;
  time: string;
  sources: { ofx_dc: number; plaid: number };
}

const FREQUENCIES = ['hourly', 'daily', 'weekly'] as const;

export function AutoSyncSection() {
  const [status, setStatus] = useState<AutoSyncStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState('daily');
  const [time, setTime] = useState('03:00');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function refresh() {
    try {
      const s = await api.autoSyncStatus();
      setStatus(s);
      setEnabled(s.enabled);
      setFrequency(s.frequency);
      setTime(s.time);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load auto-sync status');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save() {
    setBusy('save');
    setError(null);
    setInfo(null);
    try {
      await api.putSetting('AUTO_SYNC_ENABLED', enabled ? 'true' : 'false');
      await api.putSetting('AUTO_SYNC_FREQUENCY', frequency);
      await api.putSetting('AUTO_SYNC_TIME', time);
      setInfo('Saved.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function runNow() {
    setBusy('run');
    setError(null);
    setInfo(null);
    try {
      const r = await api.autoSyncRunNow();
      const o = r.ofxDc;
      const p = r.plaid;
      setInfo(
        `Tick complete — OFX-DC: ${o.attempted} attempted (${o.succeeded} ok, ${o.failed} failed); ` +
          `Plaid: ${p.attempted} attempted (${p.succeeded} ok, ${p.failed} failed).`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card row-gap" style={{ marginTop: 24 }}>
      <h2>Auto-sync</h2>
      <p className="muted">
        Periodically fetch every enabled OFX-DC connection and every
        active Plaid item. Per-source cadence — each connection has its
        own last-sync timestamp — so a 60-second tick won't flood your
        banks. Sources can still be synced manually from the tenant
        Connections page even when this is off.
      </p>

      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      {status && (
        <p className="muted">
          Currently registered: {status.sources.ofx_dc} OFX-DC
          connection{status.sources.ofx_dc === 1 ? '' : 's'},{' '}
          {status.sources.plaid} Plaid item
          {status.sources.plaid === 1 ? '' : 's'}.
        </p>
      )}

      <div className="form-grid">
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />{' '}
            Enabled
          </label>
        </div>
        <div className="field">
          <label>Frequency</label>
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Daily/weekly time (HH:MM, 24h)</label>
          <input
            value={time}
            onChange={(e) => setTime(e.target.value)}
            placeholder="03:00"
          />
        </div>
      </div>
      <div>
        <button className="btn" onClick={() => void save()} disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button
          className="btn secondary"
          style={{ marginLeft: 8 }}
          onClick={() => void runNow()}
          disabled={busy !== null}
        >
          {busy === 'run' ? 'Running…' : 'Run all syncs now'}
        </button>
      </div>
    </div>
  );
}
