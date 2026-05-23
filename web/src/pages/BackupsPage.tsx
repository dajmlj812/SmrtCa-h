import { useEffect, useState, type FormEvent } from 'react';
import { api, type BackupConfig, type BackupRecord } from '../api';

const FREQUENCIES = ['hourly', 'daily', 'weekly', 'monthly'] as const;

function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatLocal(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function BackupsPage() {
  const [history, setHistory] = useState<BackupRecord[]>([]);
  const [cfg, setCfg] = useState<BackupConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Local editable copy of the schedule form.
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<string>('daily');
  const [time, setTime] = useState('03:00');
  const [retention, setRetention] = useState(30);
  const [directory, setDirectory] = useState('');
  const [savingCfg, setSavingCfg] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [list, config] = await Promise.all([
        api.listBackupsHistory(),
        api.getBackupConfig(),
      ]);
      setHistory(list);
      setCfg(config);
      setEnabled(config.enabled);
      setFrequency(config.frequency || 'daily');
      setTime(config.time || '03:00');
      setRetention(config.retention_days || 30);
      setDirectory(config.directory && config.directory !== config.resolved_directory ? config.directory : '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function saveConfig(e: FormEvent) {
    e.preventDefault();
    setSavingCfg(true);
    setError(null);
    setSuccess(null);
    try {
      await Promise.all([
        api.putSetting('BACKUP_ENABLED', enabled ? 'true' : 'false'),
        api.putSetting('BACKUP_FREQUENCY', frequency),
        api.putSetting('BACKUP_TIME', time),
        api.putSetting('BACKUP_RETENTION_DAYS', String(retention)),
        directory.trim() !== ''
          ? api.putSetting('BACKUP_DIR', directory.trim())
          : api.clearSetting('BACKUP_DIR').catch(() => undefined),
      ]);
      setSuccess('Schedule saved. The scheduler picks up changes on the next tick.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingCfg(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setError(null);
    setSuccess(null);
    try {
      const b = await api.runBackupNow();
      if (b.status === 'success') {
        setSuccess(
          `Backup complete · ${formatBytes(b.total_bytes)} · ${b.path}`,
        );
      } else {
        setError(`Backup failed: ${b.error ?? 'unknown error'}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setRunning(false);
    }
  }

  async function pruneNow() {
    if (!window.confirm('Prune backups older than the retention window?')) return;
    try {
      const r = await api.pruneBackups();
      setSuccess(`Pruned ${r.removed} backup${r.removed === 1 ? '' : 's'}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prune failed');
    }
  }

  async function deleteOne(id: string) {
    if (!window.confirm('Delete this backup? The on-disk files will be removed.')) return;
    try {
      await api.deleteBackupRecord(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Backups</h1>
          <div className="subtitle">
            Snapshot the database and attachments to disk. Configure the
            schedule below, or click <strong>Run backup now</strong> for
            an on-demand snapshot.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn secondary"
            type="button"
            onClick={() => void pruneNow()}
          >
            Prune old
          </button>
          <button
            className="btn"
            type="button"
            disabled={running}
            onClick={() => void runNow()}
          >
            {running ? 'Running…' : 'Run backup now'}
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {success && <div className="banner success">{success}</div>}

      <div className="page-section">
        <div className="page-section-head">
          <h2>Schedule</h2>
        </div>
        <form onSubmit={saveConfig} className="card" style={{ padding: 16 }}>
          <div className="form-grid">
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />{' '}
                Enable scheduled backups
              </label>
            </div>
            <div className="field">
              <label htmlFor="bk-freq">Frequency</label>
              <select
                id="bk-freq"
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
              <label htmlFor="bk-time">Time of day (24h, server local)</label>
              <input
                id="bk-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="bk-ret">Retention (days)</label>
              <input
                id="bk-ret"
                type="number"
                min={0}
                step={1}
                value={retention}
                onChange={(e) =>
                  setRetention(Math.max(0, Number(e.target.value) || 0))
                }
              />
            </div>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label htmlFor="bk-dir">
                Backup directory{' '}
                <span className="muted">
                  (leave blank for default · resolves to{' '}
                  <code>{cfg?.resolved_directory ?? '—'}</code>)
                </span>
              </label>
              <input
                id="bk-dir"
                type="text"
                placeholder="/data/backups"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
              />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn" type="submit" disabled={savingCfg}>
              {savingCfg ? 'Saving…' : 'Save schedule'}
            </button>
          </div>
        </form>
      </div>

      <div className="page-section">
        <div className="page-section-head">
          <h2>History</h2>
          <span className="muted">{history.length} recent</span>
        </div>
        {loading ? (
          <p className="empty">Loading…</p>
        ) : history.length === 0 ? (
          <p className="empty">
            No backups yet. Click <strong>Run backup now</strong> above for
            your first snapshot.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th className="num">DB</th>
                  <th className="num">Attachments</th>
                  <th className="num">Total</th>
                  <th>Path</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {history.map((b) => (
                  <tr key={b.id}>
                    <td className="nowrap">{formatLocal(b.started_at)}</td>
                    <td>{b.kind}</td>
                    <td>
                      <span
                        className={`pill status-${b.status === 'success' ? 'keep' : b.status === 'failed' ? 'cancel' : 'review'}-pill`}
                      >
                        {b.status}
                      </span>
                      {b.error && (
                        <div className="muted" style={{ fontSize: '0.85em' }}>
                          {b.error}
                        </div>
                      )}
                    </td>
                    <td className="num">{formatBytes(b.db_bytes)}</td>
                    <td className="num">{formatBytes(b.attachments_bytes)}</td>
                    <td className="num">{formatBytes(b.total_bytes)}</td>
                    <td>
                      <code style={{ fontSize: '0.85em' }}>{b.path}</code>
                    </td>
                    <td>
                      {b.status === 'success' && (
                        <button
                          className="btn-link danger"
                          type="button"
                          onClick={() => void deleteOne(b.id)}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="banner info">
        Restore is a manual step right now — use{' '}
        <code>node scripts/restore.mjs /path/to/backup</code> from the repo
        root, or <code>pg_restore</code> directly against{' '}
        <code>db.dump</code>.
      </div>
    </div>
  );
}
