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
  type CapacityProjection,
  type HealthLogEntry,
  type HealthSlowQuery,
  type HealthSnapshot,
  type MetricSample,
  type PerformanceRecommendation,
  type PerformanceState,
  type SaasMetrics,
} from '../api';

const WINDOW_SEC = 300; // 5 minutes of trend data on each chart

interface RefreshOption {
  label: string;
  ms: number; // 0 == paused
}
const REFRESH_OPTIONS: RefreshOption[] = [
  { label: '1s',  ms: 1000 },
  { label: '5s',  ms: 5000 },
  { label: '10s', ms: 10000 },
  { label: '30s', ms: 30000 },
  { label: '60s', ms: 60000 },
  { label: 'Off', ms: 0 },
];
const REFRESH_LS_KEY = 'health:refresh_ms';
const DEFAULT_REFRESH_MS = 5000;

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
  const [saas, setSaas] = useState<SaasMetrics | null>(null);
  const [capacity, setCapacity] = useState<CapacityProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshMs, setRefreshMs] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(REFRESH_LS_KEY));
      if (REFRESH_OPTIONS.some((o) => o.ms === stored)) return stored;
    } catch {
      /* ignore */
    }
    return DEFAULT_REFRESH_MS;
  });
  const refreshRef = useRef<number>(refreshMs);
  refreshRef.current = refreshMs;

  async function load() {
    try {
      const [s, ts, sa, cap] = await Promise.all([
        api.healthMetrics(),
        api.healthTimeseries(WINDOW_SEC),
        // SaaS metrics fail silently when Stripe + billing aren't
        // configured — the operator still wants the rest of the
        // page to load on a self-host-only deployment.
        api.healthSaas().catch(() => null),
        // Capacity projection — needs ≥3 days of snapshots to
        // produce a meaningful projection; the response will report
        // sample_count low and explain it on a fresh install.
        api.healthCapacity().catch(() => null),
      ]);
      setSnapshot(s);
      setSeries(ts.points);
      setSaas(sa);
      setCapacity(cap);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load metrics');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Re-create the interval whenever the user picks a new cadence.
  // ms === 0 means paused — no interval scheduled.
  useEffect(() => {
    if (refreshMs <= 0) return;
    const t = setInterval(() => void load(), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);

  function changeRefresh(ms: number) {
    setRefreshMs(ms);
    try {
      localStorage.setItem(REFRESH_LS_KEY, String(ms));
    } catch {
      /* ignore */
    }
  }

  const latest = series.length > 0 ? series[series.length - 1]! : null;
  // Use V8's hard ceiling (heap_size_limit) as the denominator. The
  // older heap_used / heap_total ratio routinely sits at 70–90% because
  // V8 grows heap_total only when needed, which made the gauge look
  // alarming when it wasn't.
  const heapPct = snapshot
    ? (snapshot.app.heap_used_bytes / Math.max(snapshot.app.heap_size_limit_bytes, 1)) * 100
    : 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Health</h1>
          <div className="subtitle">
            Live app + database + storage metrics ·
            charts show last {WINDOW_SEC / 60} min.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="muted" htmlFor="refresh-sel">
            Refresh
          </label>
          <select
            id="refresh-sel"
            value={refreshMs}
            onChange={(e) => changeRefresh(Number(e.target.value))}
          >
            {REFRESH_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
          <button className="btn" type="button" onClick={() => void load()}>
            Refresh now
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {!snapshot ? (
        <p className="empty">Loading…</p>
      ) : (
        <>
          {/* ── Capacity projection (top — what plan-ahead operators look at) ─ */}
          {capacity && <CapacityWidget capacity={capacity} />}

          {/* ── Performance recommendations (scheduled + on-demand) ─ */}
          <PerformanceWidget />

          {/* ── Host resources (disk free, host memory, load average) ─ */}
          <HostWidget host={snapshot.host} />

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
              hint={`${formatBytes(snapshot.app.heap_used_bytes)} of ${formatBytes(snapshot.app.heap_size_limit_bytes)} cap`}
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
              <Row
                label="Heap used / total / cap"
                value={`${formatBytes(snapshot.app.heap_used_bytes)} / ${formatBytes(snapshot.app.heap_total_bytes)} / ${formatBytes(snapshot.app.heap_size_limit_bytes)}`}
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

          {/* ── On-demand diagnostics: logs + slow queries ──── */}
          <div className="diag-grid">
            <RecentLogsPanel />
            <SlowQueriesPanel />
          </div>
        </>
      )}

      {/* ── 0.15.5: SaaS operator section ─────────────────── */}
      {saas && (
        <div className="health-grid" style={{ marginTop: 16 }}>
          <Card title="Tenants">
            <Row label="Total tenants" value={saas.tenants.total.toLocaleString()} />
            <Row
              label="With active subscription"
              value={saas.tenants.with_active_sub.toLocaleString()}
            />
          </Card>

          <Card title="Subscriptions">
            <Row label="Total rows" value={saas.subscriptions.total.toLocaleString()} />
            <Row
              label="By plan"
              value={
                <span>
                  starter <strong>{saas.subscriptions.by_plan.starter}</strong> ·{' '}
                  plus <strong>{saas.subscriptions.by_plan.plus}</strong> ·{' '}
                  family <strong>{saas.subscriptions.by_plan.family}</strong>
                </span>
              }
            />
            <div className="health-counts">
              {Object.entries(saas.subscriptions.by_status).map(([status, n]) => (
                <span key={status} className="health-count">
                  <strong>{n}</strong> {status}
                </span>
              ))}
              {Object.keys(saas.subscriptions.by_status).length === 0 && (
                <span className="muted">No subscriptions yet</span>
              )}
            </div>
          </Card>

          <Card title="Stripe webhooks">
            <Row
              label="Processed (lifetime)"
              value={saas.webhooks.processed_total.toLocaleString()}
            />
            <Row
              label="Processed (24h)"
              value={saas.webhooks.processed_24h.toLocaleString()}
            />
            <Row
              label="Last event"
              value={
                saas.webhooks.last_event_at
                  ? saas.webhooks.last_event_at.slice(0, 19).replace('T', ' ')
                  : '—'
              }
            />
          </Card>
        </div>
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

/**
 * 0.18.13 — capacity projection widget. The headline number is the
 * recommended "prepare new environment by" date — that's what the
 * operator wants to know to plan a server swap. Underneath we show
 * the per-metric growth rates so the operator can see WHY they're
 * about to need more capacity (db rows, attachments, backups).
 */
function CapacityWidget({ capacity }: { capacity: CapacityProjection }) {
  const c = capacity.current;
  const p = capacity.projection;
  const statusClass = `capacity-status capacity-${p.status}`;
  const statusLabel =
    p.status === 'critical'
      ? '🚨 Critical — disk nearly full'
      : p.status === 'warn'
        ? '⚠ Plan migration soon'
        : p.status === 'ok'
          ? '✓ On track'
          : '— Insufficient history';

  return (
    <div className="card capacity-widget">
      <div className="capacity-header">
        <h3 style={{ margin: 0 }}>Server capacity</h3>
        <span className={statusClass}>{statusLabel}</span>
      </div>

      {/* Top recommendation — biggest, most prominent */}
      <div className="capacity-prepare">
        {p.recommended_prepare_by ? (
          <>
            <div className="capacity-prepare-label muted">
              Have a replacement environment ready to swap by
            </div>
            <div className="capacity-prepare-date">
              {formatRelDate(p.recommended_prepare_by)}
            </div>
            <div className="capacity-prepare-detail muted">
              ≈ {p.days_until_warn} days to warn ({formatRelDate(p.warn_date)}) ·{' '}
              {p.days_until_critical} days to critical (
              {formatRelDate(p.critical_date)})
            </div>
          </>
        ) : (
          <div className="capacity-prepare-detail muted">
            {p.note ?? 'No projection available.'}
          </div>
        )}
      </div>

      {/* Disk usage bar */}
      {c.disk_total_bytes != null && c.disk_used_bytes != null && (
        <div className="capacity-disk">
          <div className="capacity-disk-label">
            <span>Disk usage</span>
            <span className="muted">
              {formatBytes(c.disk_used_bytes)} of {formatBytes(c.disk_total_bytes)}
              {' · '}
              {(c.disk_percent_used ?? 0).toFixed(1)}%
            </span>
          </div>
          <div className="capacity-bar">
            <div
              className={`capacity-bar-fill ${p.status}`}
              style={{ width: `${Math.min(100, c.disk_percent_used ?? 0)}%` }}
            />
            {/* 80% warn marker */}
            <div className="capacity-bar-marker" style={{ left: '80%' }} />
          </div>
        </div>
      )}

      {/* Per-component growth */}
      <div className="capacity-growth">
        <Row
          label="Database growth"
          value={formatGrowth(capacity.growth.db_bytes_per_day, c.db_bytes)}
        />
        <Row
          label="Attachments growth"
          value={formatGrowth(
            capacity.growth.attachments_bytes_per_day,
            c.attachments_bytes,
          )}
        />
        <Row
          label="Backups growth"
          value={formatGrowth(
            capacity.growth.backups_bytes_per_day,
            c.backups_bytes,
          )}
        />
        {p.combined_bytes_per_day != null && (
          <Row
            label="Combined app growth"
            value={
              <strong>
                {formatBytes(p.combined_bytes_per_day)} per day
              </strong>
            }
          />
        )}
        <Row
          label="Projection window"
          value={
            p.window
              ? `${p.window.from} → ${p.window.to} (${p.sample_count} samples)`
              : `${p.sample_count} samples — need ≥ 3 for a projection`
          }
        />
      </div>

      {p.note && p.status !== 'ok' && (
        <div className="muted small" style={{ marginTop: 8 }}>
          {p.note}
        </div>
      )}
    </div>
  );
}

function formatGrowth(bytesPerDay: number | null, total: number): React.ReactNode {
  if (bytesPerDay == null) return <span className="muted">— not enough data</span>;
  if (bytesPerDay === 0) return <span className="muted">flat (no growth)</span>;
  const yearProjected = bytesPerDay * 365;
  return (
    <>
      <strong>{formatBytes(bytesPerDay)}</strong>/day · currently{' '}
      {formatBytes(total)} · ≈ {formatBytes(yearProjected)}/yr
    </>
  );
}

function formatRelDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00Z');
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const days = Math.round(
    (d.getTime() - todayUtc.getTime()) / (24 * 60 * 60 * 1000),
  );
  const niceDate = d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  if (days <= 0) return `${niceDate} (today)`;
  if (days === 1) return `${niceDate} (tomorrow)`;
  return `${niceDate} (in ${days} days)`;
}

/**
 * Host resources card — disk free per mount, host memory, load
 * average. Complements the per-process metrics already shown in the
 * other cards.
 */
function HostWidget({
  host,
}: {
  host: HealthSnapshot['host'];
}) {
  const memPct = host.memory_percent_used;
  const memClass =
    memPct >= 90 ? 'warn' : memPct >= 75 ? 'caution' : 'ok';
  return (
    <Card title="Host resources">
      <div className="health-grid">
        <Row
          label="Hostname"
          value={
            <>
              {host.hostname}{' '}
              <span className="muted">
                ({host.platform}/{host.arch})
              </span>
            </>
          }
        />
        <Row label="CPU cores" value={host.cpu_count} />
        <Row
          label="Load average"
          value={
            host.load_average[0] === 0 &&
            host.load_average[1] === 0 &&
            host.load_average[2] === 0 ? (
              <span className="muted">— (Windows reports 0)</span>
            ) : (
              <>
                {host.load_average[0].toFixed(2)} ·{' '}
                {host.load_average[1].toFixed(2)} ·{' '}
                {host.load_average[2].toFixed(2)}
                <span className="muted"> (1m · 5m · 15m)</span>
              </>
            )
          }
        />
        <Row label="Host uptime" value={formatUptime(host.uptime_seconds)} />
        <Row
          label="Host memory"
          value={
            <span className={`pill ${memClass}`}>
              {formatBytes(host.memory_used_bytes)} /{' '}
              {formatBytes(host.memory_total_bytes)} ·{' '}
              {memPct.toFixed(1)}%
            </span>
          }
        />
        {host.disks.map((d) => {
          const cls =
            d.percent_used >= 90 ? 'warn' : d.percent_used >= 75 ? 'caution' : 'ok';
          return (
            <Row
              key={d.path}
              label={`Disk · ${d.label}`}
              value={
                <span className={`pill ${cls}`} title={d.path}>
                  {formatBytes(d.used_bytes)} / {formatBytes(d.total_bytes)} ·{' '}
                  {d.percent_used.toFixed(1)}% used ·{' '}
                  {formatBytes(d.free_bytes)} free
                </span>
              }
            />
          );
        })}
        {host.disks.length === 0 && (
          <Row
            label="Disk"
            value={
              <span className="muted">
                statfs() unavailable on this platform — capacity projection
                cannot use disk-free signal
              </span>
            }
          />
        )}
      </div>
    </Card>
  );
}

/**
 * 0.18.13 — recent warn/error/fatal log entries, fetched on demand.
 *
 * The page-wide auto-refresh (5s by default) does NOT poll this — it
 * would generate noise and risk capturing this very poll's log line
 * in the buffer. The operator clicks "Refresh" when they actually
 * want the latest. Entries are read from an in-memory ring buffer on
 * the server (200-entry cap); they don't survive a restart.
 */
function RecentLogsPanel() {
  const [entries, setEntries] = useState<HealthLogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.healthLogs(50);
      setEntries(r.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card title="Recent warnings & errors">
      <div className="diag-actions">
        <button
          className="btn small"
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Loading…' : entries === null ? 'Load latest' : 'Refresh'}
        </button>
        {entries !== null && (
          <span className="muted small">
            {entries.length === 0
              ? 'no warn / error / fatal entries in the buffer'
              : `showing ${entries.length} most recent`}
          </span>
        )}
      </div>
      {error && <div className="banner error">{error}</div>}
      {entries !== null && entries.length > 0 && (
        <div className="diag-log-list">
          {[...entries].reverse().map((e, i) => (
            <div key={i} className={`diag-log-entry diag-log-${e.level}`}>
              <div className="diag-log-row1">
                <span className={`pill ${e.level === 'fatal' || e.level === 'error' ? 'warn' : 'caution'}`}>
                  {e.level.toUpperCase()}
                </span>
                <span className="muted small">{formatLogTs(e.ts)}</span>
              </div>
              <div className="diag-log-msg">{e.msg || <em className="muted">(empty)</em>}</div>
              {e.context && Object.keys(e.context).length > 0 && (
                <div className="muted small diag-log-context">
                  {Object.entries(e.context)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * 0.18.13 — recent slow queries, sorted slowest first. Threshold is
 * server-controlled (default 100ms; set SLOW_QUERY_THRESHOLD_MS env
 * lower for an afternoon of profiling, then revert). Same on-demand
 * fetch model as the log viewer above.
 */
function SlowQueriesPanel() {
  const [entries, setEntries] = useState<HealthSlowQuery[] | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.healthSlowQueries(50);
      setEntries(r.entries);
      setThreshold(r.threshold_ms);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load slow queries');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card title="Slow queries">
      <div className="diag-actions">
        <button
          className="btn small"
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Loading…' : entries === null ? 'Load latest' : 'Refresh'}
        </button>
        {threshold !== null && (
          <span className="muted small">
            threshold: ≥ {threshold} ms
            {entries && entries.length > 0
              ? ` · showing ${entries.length} slowest`
              : entries
                ? ' · nothing crossed the threshold yet'
                : ''}
          </span>
        )}
      </div>
      {error && <div className="banner error">{error}</div>}
      {entries !== null && entries.length > 0 && (
        <div className="diag-query-list">
          {entries.map((e, i) => {
            const cls =
              e.duration_ms >= 1000
                ? 'warn'
                : e.duration_ms >= 500
                  ? 'caution'
                  : 'ok';
            return (
              <div key={i} className="diag-query-entry">
                <div className="diag-query-row1">
                  <span className={`pill ${cls}`}>{e.duration_ms} ms</span>
                  <span className="muted small">{formatLogTs(e.ts)}</span>
                  {e.param_count > 0 && (
                    <span className="muted small">
                      · {e.param_count} param{e.param_count === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <code className="diag-query-sql">{e.sql}</code>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function formatLogTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour12: false });
}

/**
 * 0.18.13 — performance recommendations widget.
 *
 * Shows the latest scheduled analysis result + scheduler metadata
 * (next-run, interval setting, currently-running flag). Auto-loads on
 * page open + auto-refreshes every 60s so the next-run countdown
 * stays current (the actual analysis runs on the server every
 * PERFORMANCE_ANALYSIS_INTERVAL_HOURS hours). The "Run now" button
 * fires an immediate run for ad-hoc investigation.
 *
 * Severity grouping: critical at top, then warning, then info. Empty
 * state ("everything looks fine") matters too — it's positive
 * feedback that the system is healthy.
 */
function PerformanceWidget() {
  const [state, setState] = useState<PerformanceState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.healthPerformance();
      setState(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load performance report');
    }
  }
  async function runNow() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.healthPerformanceRun();
      setState(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run analyzer');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Refresh the scheduler metadata every 60s so the "next run in
    // X" indicator stays roughly current. The actual analysis runs
    // server-side on its own schedule (default 24h).
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, []);

  if (!state) {
    return (
      <Card title="Performance recommendations">
        <p className="empty">Loading…</p>
      </Card>
    );
  }

  const latest = state.latest;
  const recs = latest?.recommendations ?? [];
  const counts = {
    critical: recs.filter((r) => r.severity === 'critical').length,
    warning: recs.filter((r) => r.severity === 'warning').length,
    info: recs.filter((r) => r.severity === 'info').length,
  };

  return (
    <div className="card performance-widget">
      <div className="performance-header">
        <div>
          <h3 style={{ margin: 0 }}>Performance recommendations</h3>
          <div className="muted small" style={{ marginTop: 4 }}>
            {latest
              ? `Last analyzed ${relativeTime(latest.generated_at)} · ${latest.checks_run} checks · ${latest.duration_ms} ms`
              : 'No analysis has run yet (boot-time analysis kicks off ~30 s after restart).'}
            {state.next_scheduled_at &&
              ` · Next ${relativeTime(state.next_scheduled_at)}`}
            {` · Every ${state.interval_hours}h`}
          </div>
        </div>
        <button
          className="btn small"
          type="button"
          onClick={() => void runNow()}
          disabled={loading || state.running}
        >
          {loading || state.running ? 'Running…' : 'Run now'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {!latest ? (
        <p className="muted">Click "Run now" to generate the first report.</p>
      ) : recs.length === 0 ? (
        <div className="performance-clean">
          ✅ <strong>All checks passed.</strong>{' '}
          <span className="muted">
            No issues detected across {latest.checks_run} runtime checks.
          </span>
        </div>
      ) : (
        <>
          <div className="performance-counts">
            {counts.critical > 0 && (
              <span className="pill warn">
                {counts.critical} critical
              </span>
            )}
            {counts.warning > 0 && (
              <span className="pill caution">{counts.warning} warning</span>
            )}
            {counts.info > 0 && (
              <span className="pill ok">{counts.info} info</span>
            )}
          </div>
          <div className="performance-list">
            {recs.map((r) => (
              <RecommendationCard key={r.id} rec={r} />
            ))}
          </div>
        </>
      )}

      <div className="muted small performance-config-hint">
        Adjust the refresh interval in /settings →{' '}
        <code>PERFORMANCE_ANALYSIS_INTERVAL_HOURS</code> (1-168 hours,
        default 24).
      </div>
    </div>
  );
}

function RecommendationCard({ rec }: { rec: PerformanceRecommendation }) {
  const sevClass =
    rec.severity === 'critical'
      ? 'critical'
      : rec.severity === 'warning'
        ? 'warning'
        : 'info';
  return (
    <details className={`rec-card rec-${sevClass}`}>
      <summary>
        <span className={`pill ${sevClass === 'critical' ? 'warn' : sevClass === 'warning' ? 'caution' : 'ok'}`}>
          {rec.severity}
        </span>
        <span className="rec-title">{rec.title}</span>
        <span className="muted small rec-effort">{rec.effort} effort</span>
      </summary>
      <div className="rec-body">
        <div className="rec-section">
          <strong>What's happening</strong>
          <p>{rec.summary}</p>
        </div>
        <div className="rec-section">
          <strong>Evidence</strong>
          <p className="rec-evidence">{rec.evidence}</p>
        </div>
        <div className="rec-section">
          <strong>Recommendation</strong>
          <p>{rec.recommendation}</p>
        </div>
      </div>
    </details>
  );
}

function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = d - Date.now();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return diff < 0 ? `${min}m ago` : `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return diff < 0 ? `${hr}h ago` : `in ${hr}h`;
  const days = Math.round(hr / 24);
  return diff < 0 ? `${days}d ago` : `in ${days}d`;
}
