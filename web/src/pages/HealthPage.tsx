import { useEffect, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  api,
  type HealthSnapshot,
  type MetricSample,
} from '../api';

const POLL_MS = 5000;
const WINDOW_SEC = 300; // 5 minutes of trend data on each chart

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

/**
 * Format the timestamp axis label to HH:MM:SS in the user's locale —
 * keeps tick density manageable on a 5-minute window.
 */
function formatTickTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour12: false });
}

export function HealthPage() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [series, setSeries] = useState<MetricSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  async function load() {
    try {
      const [s, ts] = await Promise.all([
        api.healthMetrics(),
        api.healthTimeseries(WINDOW_SEC),
      ]);
      setSnapshot(s);
      setSeries(ts.points);
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

  const latest = series.length > 0 ? series[series.length - 1]! : null;
  const heapPct = snapshot
    ? (snapshot.app.heap_used_bytes / Math.max(snapshot.app.heap_total_bytes, 1)) * 100
    : 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Health</h1>
          <div className="subtitle">
            Live app + database + storage metrics. Refreshes every{' '}
            {POLL_MS / 1000}s · charts show last {WINDOW_SEC / 60} min.
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
        <>
          {/* ── Live gauges row ─────────────────────────────── */}
          <div className="gauge-grid">
            <Gauge
              label="CPU"
              value={latest?.cpu_pct ?? 0}
              max={100}
              suffix="%"
              tone={toneForPct(latest?.cpu_pct ?? 0, 70, 90)}
            />
            <Gauge
              label="Heap"
              value={heapPct}
              max={100}
              suffix="%"
              hint={`${formatBytes(snapshot.app.heap_used_bytes)} / ${formatBytes(snapshot.app.heap_total_bytes)}`}
              tone={toneForPct(heapPct, 70, 90)}
            />
            <Gauge
              label="Event loop lag"
              value={latest?.event_loop_p99_ms ?? 0}
              max={100}
              suffix=" ms"
              hint={`p99 · mean ${(latest?.event_loop_mean_ms ?? 0).toFixed(1)} ms`}
              tone={toneForLag(latest?.event_loop_p99_ms ?? 0)}
            />
            <Gauge
              label="Req / sec"
              value={latest?.req_rate ?? 0}
              max={Math.max(10, (latest?.req_rate ?? 0) * 1.2)}
              suffix=""
              hint={`${latest?.req_count ?? 0} in last 5s`}
              tone="ok"
            />
            <Gauge
              label="DB qps"
              value={latest?.db_query_rate ?? 0}
              max={Math.max(20, (latest?.db_query_rate ?? 0) * 1.2)}
              suffix=""
              hint={`mean ${(latest?.db_query_mean_ms ?? 0).toFixed(1)} ms · max ${(latest?.db_query_max_ms ?? 0).toFixed(0)} ms`}
              tone={toneForLatency(latest?.db_query_mean_ms ?? 0)}
            />
            <Gauge
              label="Error rate"
              value={(latest?.err_rate ?? 0) * 100}
              max={10}
              suffix="%"
              hint={`${latest?.err_count ?? 0} 5xx in last 5s`}
              tone={toneForErr(latest?.err_rate ?? 0)}
            />
          </div>

          {/* ── Line charts row ─────────────────────────────── */}
          <div className="chart-grid">
            <ChartCard title="CPU %" yMax={100}>
              <LineChart data={series}>
                {chartFurniture()}
                <YAxis domain={[0, 100]} width={45} tick={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="cpu_pct"
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartCard>

            <ChartCard title="Memory (MB)">
              <LineChart data={series}>
                {chartFurniture()}
                <YAxis
                  width={50}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => (v / 1024 / 1024).toFixed(0)}
                />
                <Line type="monotone" dataKey="rss_bytes" name="RSS" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="heap_used_bytes" name="Heap used" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ChartCard>

            <ChartCard title="Requests / sec">
              <LineChart data={series}>
                {chartFurniture()}
                <YAxis width={45} tick={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="req_rate" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ChartCard>

            <ChartCard title="DB query rate + latency">
              <LineChart data={series}>
                {chartFurniture()}
                <YAxis yAxisId="left" width={45} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" width={50} tick={{ fontSize: 11 }} />
                <Line yAxisId="left"  type="monotone" dataKey="db_query_rate"   name="qps"     stroke="#8b5cf6" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line yAxisId="right" type="monotone" dataKey="db_query_mean_ms" name="mean ms" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ChartCard>

            <ChartCard title="Event loop lag (ms)">
              <LineChart data={series}>
                {chartFurniture()}
                <YAxis width={45} tick={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="event_loop_mean_ms" name="mean" stroke="#0ea5e9" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="event_loop_p99_ms"  name="p99"  stroke="#dc2626" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ChartCard>

            <ChartCard title="Errors / sec">
              <LineChart data={series}>
                {chartFurniture()}
                <YAxis width={45} tick={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="err_count" stroke="#dc2626" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ChartCard>
          </div>

          {/* ── Static info cards ───────────────────────────── */}
          <div className="health-grid" style={{ marginTop: 16 }}>
            <Card title="Application">
              <Row label="Version" value={snapshot.app.app_version} />
              <Row label="Node" value={snapshot.app.node_version} />
              <Row label="Environment" value={snapshot.app.env} />
              <Row label="Uptime" value={formatUptime(snapshot.app.uptime_seconds)} />
              <Row label="PID" value={String(snapshot.app.pid)} />
              <Row label="RSS" value={formatBytes(snapshot.app.rss_bytes)} />
              <Row label="Heap" value={`${formatBytes(snapshot.app.heap_used_bytes)} / ${formatBytes(snapshot.app.heap_total_bytes)}`} />
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
              <Row label="Ping" value={snapshot.db.ping_ms >= 0 ? `${snapshot.db.ping_ms} ms` : '—'} />
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
        </>
      )}

      {snapshot && (
        <p className="muted" style={{ marginTop: 12 }}>
          Snapshot {snapshot.generated_at} · {series.length} points in buffer
        </p>
      )}
    </div>
  );
}

/** Common XAxis + grid + tooltip for the metric charts. */
function chartFurniture() {
  return (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
      <XAxis
        dataKey="ts"
        tick={{ fontSize: 10 }}
        tickFormatter={formatTickTime}
        minTickGap={40}
      />
      <Tooltip
        labelFormatter={(label) =>
          typeof label === 'string'
            ? new Date(label).toLocaleTimeString()
            : String(label ?? '')
        }
        contentStyle={{ fontSize: '0.85em' }}
      />
    </>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactElement;
  yMax?: number;
}) {
  return (
    <div className="card chart-card">
      <div className="chart-title">{title}</div>
      <div style={{ width: '100%', height: 180 }}>
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

type Tone = 'ok' | 'warn' | 'crit';
function toneForPct(v: number, warn: number, crit: number): Tone {
  if (v >= crit) return 'crit';
  if (v >= warn) return 'warn';
  return 'ok';
}
function toneForLag(p99: number): Tone {
  if (p99 >= 100) return 'crit';
  if (p99 >= 50) return 'warn';
  return 'ok';
}
function toneForLatency(meanMs: number): Tone {
  if (meanMs >= 200) return 'crit';
  if (meanMs >= 50) return 'warn';
  return 'ok';
}
function toneForErr(rate: number): Tone {
  if (rate >= 0.05) return 'crit';
  if (rate >= 0.01) return 'warn';
  return 'ok';
}

/** Pure-SVG donut gauge. Tone drives the arc color. */
function Gauge({
  label,
  value,
  max,
  suffix,
  hint,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  suffix: string;
  hint?: string;
  tone: Tone;
}) {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.max(0, Math.min(value, safeMax));
  const pct = (clamped / safeMax) * 100;
  // Arc geometry: 180° semicircle, radius 50, center (60, 60).
  const r = 50;
  const cx = 60;
  const cy = 60;
  const angleEnd = Math.PI * (pct / 100);
  const x2 = cx - r * Math.cos(angleEnd);
  const y2 = cy - r * Math.sin(angleEnd);
  const largeArc = pct > 50 ? 1 : 0;
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  const trackPath = `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}`;
  const toneStroke =
    tone === 'crit' ? '#dc2626' : tone === 'warn' ? '#f59e0b' : '#10b981';

  // Display value: round to 1 decimal place when it has a fraction.
  const display = value >= 100 ? value.toFixed(0) : value.toFixed(1);

  return (
    <div className={`gauge gauge-tone-${tone}`}>
      <svg viewBox="0 0 120 75" preserveAspectRatio="xMidYMid meet">
        <path d={trackPath} stroke="#e5e7eb" strokeWidth={10} fill="none" strokeLinecap="round" />
        <path d={arcPath}   stroke={toneStroke} strokeWidth={10} fill="none" strokeLinecap="round" />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="20" fontWeight="700" fill="#1f2937">
          {display}
          <tspan fontSize="12" fontWeight="500" fill="#6b7280">{suffix}</tspan>
        </text>
      </svg>
      <div className="gauge-label">{label}</div>
      {hint && <div className="gauge-hint">{hint}</div>}
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
