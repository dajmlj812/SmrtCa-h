import { useEffect, useRef, useState } from 'react';
import { api, type HealthSnapshot } from '../api';

const POLL_MS = 5000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function HealthPage() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  async function load() {
    try {
      const s = await api.healthMetrics();
      setSnapshot(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load metrics');
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (!pausedRef.current) void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Health</h1>
          <div className="subtitle">
            Live app + database + storage metrics. Refreshes every{' '}
            {POLL_MS / 1000}s.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn secondary"
            type="button"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn" type="button" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {!snapshot ? (
        <p className="empty">Loading…</p>
      ) : (
        <div className="health-grid">
          <Card title="Application">
            <Row label="Version" value={snapshot.app.app_version} />
            <Row label="Node" value={snapshot.app.node_version} />
            <Row label="Environment" value={snapshot.app.env} />
            <Row
              label="Uptime"
              value={formatUptime(snapshot.app.uptime_seconds)}
            />
            <Row label="PID" value={String(snapshot.app.pid)} />
            <Row label="RSS" value={formatBytes(snapshot.app.rss_bytes)} />
            <Row
              label="Heap"
              value={`${formatBytes(snapshot.app.heap_used_bytes)} / ${formatBytes(snapshot.app.heap_total_bytes)}`}
            />
            <Row
              label="AI"
              value={
                snapshot.app.ai_provider === 'none'
                  ? 'disabled'
                  : `${snapshot.app.ai_provider}${snapshot.app.ai_model ? ` · ${snapshot.app.ai_model}` : ''}`
              }
            />
          </Card>

          <Card title="Database">
            <Row
              label="Connection"
              value={
                snapshot.db.connected ? (
                  <span className="pill status-keep-pill">OK</span>
                ) : (
                  <span className="pill status-cancel-pill">DOWN</span>
                )
              }
            />
            <Row
              label="Ping"
              value={snapshot.db.ping_ms >= 0 ? `${snapshot.db.ping_ms} ms` : '—'}
            />
            <Row label="Size" value={snapshot.db.size_pretty || formatBytes(snapshot.db.size_bytes)} />
            <Row
              label="Pool"
              value={`${snapshot.db.pool_total} total · ${snapshot.db.pool_idle} idle · ${snapshot.db.pool_waiting} waiting`}
            />
            <Row
              label="Last migration"
              value={
                snapshot.db.last_migration
                  ? `${snapshot.db.last_migration}${snapshot.db.last_migration_at ? ` · ${snapshot.db.last_migration_at.slice(0, 16).replace('T', ' ')}` : ''}`
                  : '—'
              }
            />
            <div className="health-counts">
              {Object.entries(snapshot.db.table_counts).map(([table, count]) => (
                <span key={table} className="health-count">
                  <strong>{count.toLocaleString()}</strong> {table}
                </span>
              ))}
            </div>
          </Card>

          <Card title="Storage">
            <Row
              label="Attachments"
              value={`${snapshot.storage.attachments_count.toLocaleString()} file${snapshot.storage.attachments_count === 1 ? '' : 's'} · ${formatBytes(snapshot.storage.attachments_bytes)}`}
            />
            <Row
              label="Backups"
              value={`${snapshot.storage.backup_count.toLocaleString()} file${snapshot.storage.backup_count === 1 ? '' : 's'} · ${formatBytes(snapshot.storage.backups_bytes)}`}
            />
            <Row label="Attachments dir" value={<code>{snapshot.storage.attachments_dir}</code>} />
            <Row label="Backups dir" value={<code>{snapshot.storage.backups_dir}</code>} />
          </Card>
        </div>
      )}

      {snapshot && (
        <p className="muted" style={{ marginTop: 12 }}>
          Snapshot {snapshot.generated_at}
        </p>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card health-card">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="health-row">
      <span className="muted">{label}</span>
      <span className="health-value">{value}</span>
    </div>
  );
}
