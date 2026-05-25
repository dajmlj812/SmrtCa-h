import { stat, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import v8 from 'node:v8';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { resolveBackupDir } from './backup-runner.js';

/**
 * Live health snapshot for the /health page.
 *
 * Cheap-by-design: every metric is either a pre-computed counter on the
 * process (uptime, memory) or a single SELECT that finishes in <10ms.
 * The page polls this endpoint on a short interval — keep it that way.
 */

export interface AppMetrics {
  app_version: string;
  node_version: string;
  uptime_seconds: number;
  pid: number;
  env: string;
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  /**
   * V8's hard heap ceiling. `heap_used / heap_size_limit` is the real
   * "how close are we to OOM" signal — `heap_total` is dynamic and
   * commonly sits at 70–90% of itself in steady-state, which makes
   * `heap_used / heap_total` a misleading gauge.
   */
  heap_size_limit_bytes: number;
  ai_provider: string;
  ai_model: string;
}

export interface DbMetrics {
  connected: boolean;
  pool_total: number;
  pool_idle: number;
  pool_waiting: number;
  size_bytes: number;
  size_pretty: string;
  table_counts: Record<string, number>;
  last_migration: string | null;
  last_migration_at: string | null;
  /** Round-trip latency of a `SELECT 1` in milliseconds. */
  ping_ms: number;
}

export interface StorageMetrics {
  attachments_dir: string;
  attachments_bytes: number;
  attachments_count: number;
  backups_dir: string;
  backups_bytes: number;
  backup_count: number;
}

/**
 * Host-level metrics — anything that comes from the OS rather than from
 * the Node process or the application database. Drives the capacity
 * widget on /health: without disk-free we'd have no way to project
 * "days until full." `os.freemem()` / `os.totalmem()` reflect the
 * cgroup-visible memory inside a container, which is what we want.
 *
 * On Windows, `os.loadavg()` returns [0, 0, 0] (POSIX-only concept).
 * The frontend handles that case explicitly.
 */
export interface DiskMount {
  /** The on-disk path we asked about. Two paths in two cgroups can share a mount. */
  path: string;
  /** `mount` label — for prod this is usually just the mount or "/" path the path resolves to */
  label: string;
  total_bytes: number;
  free_bytes: number;
  used_bytes: number;
  percent_used: number;
}

export interface HostMetrics {
  hostname: string;
  platform: string;
  arch: string;
  cpu_count: number;
  /** UNIX 1/5/15-minute load averages. [0,0,0] on Windows. */
  load_average: [number, number, number];
  uptime_seconds: number;
  memory_total_bytes: number;
  memory_free_bytes: number;
  memory_used_bytes: number;
  memory_percent_used: number;
  disks: DiskMount[];
}

export interface HealthSnapshot {
  generated_at: string;
  app: AppMetrics;
  db: DbMetrics;
  storage: StorageMetrics;
  host: HostMetrics;
}

const APP_VERSION = process.env.npm_package_version ?? '0.7.6';

const TRACKED_TABLES = [
  'accounts',
  'transactions',
  'categories',
  'bills',
  'budgets',
  'savings_goals',
  'attachments',
  'backups',
];

export async function collectHealth(): Promise<HealthSnapshot> {
  const [app, db, storage, host] = await Promise.all([
    collectApp(),
    collectDb(),
    collectStorage(),
    collectHost(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    app,
    db,
    storage,
    host,
  };
}

/**
 * Host CPU / memory / disk snapshot.
 *
 * Disk: we statfs() each of the directories the application actually
 * writes to (attachments + backups). Inside a container these often
 * resolve to the same physical mount, which is fine — the widget
 * deduplicates on the resolved label.
 *
 * Memory: `os.totalmem()` and `os.freemem()` honor container cgroup
 * limits on modern Node (v22), so values reflect the container's
 * memory ceiling, not the entire host's RAM. That's what we want for
 * capacity planning when the app runs in a container.
 */
async function collectHost(): Promise<HostMetrics> {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const memoryUsed = memoryTotal - memoryFree;

  const disks = await collectDisks();

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpu_count: os.cpus().length,
    load_average: os.loadavg() as [number, number, number],
    uptime_seconds: Math.floor(os.uptime()),
    memory_total_bytes: memoryTotal,
    memory_free_bytes: memoryFree,
    memory_used_bytes: memoryUsed,
    memory_percent_used:
      memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0,
    disks,
  };
}

async function collectDisks(): Promise<DiskMount[]> {
  // We probe the dirs the app writes to. Operators on a multi-mount
  // setup who put attachments on a different volume than backups will
  // see two separate entries. On a typical single-volume install both
  // entries resolve to the same statfs and dedup below collapses them.
  const probePaths = [
    { path: config.attachmentsDir, label: 'attachments' },
    { path: await resolveBackupDir(), label: 'backups' },
  ];
  const results: DiskMount[] = [];
  const seen = new Set<string>();
  for (const probe of probePaths) {
    try {
      const fs = await statfs(probe.path);
      const total = fs.blocks * fs.bsize;
      const free = fs.bavail * fs.bsize;
      const used = total - free;
      // Dedupe across probes that resolve to the same fs (same total
      // bytes + bavail is a near-certain match in practice).
      const key = `${total}:${fs.bavail}`;
      if (seen.has(key)) {
        // Already covered — just rename the label to show both purposes.
        const existing = results.find(
          (r) => r.total_bytes === total && r.free_bytes === free,
        );
        if (existing) existing.label += ` + ${probe.label}`;
        continue;
      }
      seen.add(key);
      results.push({
        path: probe.path,
        label: probe.label,
        total_bytes: total,
        free_bytes: free,
        used_bytes: used,
        percent_used: total > 0 ? (used / total) * 100 : 0,
      });
    } catch {
      /* missing path or unsupported platform — skip silently */
    }
  }
  return results;
}

function collectApp(): Promise<AppMetrics> {
  const mem = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  return Promise.resolve({
    app_version: APP_VERSION,
    node_version: process.version,
    uptime_seconds: Math.floor(process.uptime()),
    pid: process.pid,
    env: config.nodeEnv,
    rss_bytes: mem.rss,
    heap_used_bytes: mem.heapUsed,
    heap_total_bytes: mem.heapTotal,
    heap_size_limit_bytes: heap.heap_size_limit,
    ai_provider: config.ai.provider,
    ai_model:
      config.ai.provider === 'claude'
        ? config.ai.anthropicModel
        : config.ai.provider === 'ollama'
          ? config.ai.ollamaModel
          : '',
  });
}

async function collectDb(): Promise<DbMetrics> {
  const tableCounts: Record<string, number> = {};
  let connected = false;
  let pingMs = -1;
  let sizeBytes = 0;
  let sizePretty = '';
  let lastMigration: string | null = null;
  let lastMigrationAt: string | null = null;

  try {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    pingMs = Date.now() - t0;
    connected = true;

    const sizeRes = await pool.query<{ bytes: number; pretty: string }>(
      `SELECT pg_database_size(current_database())::bigint AS bytes,
              pg_size_pretty(pg_database_size(current_database())) AS pretty`,
    );
    sizeBytes = Number(sizeRes.rows[0]?.bytes ?? 0);
    sizePretty = sizeRes.rows[0]?.pretty ?? '';

    // Each table counted in its own short query — gives us per-table
    // visibility without scanning the whole catalog.
    for (const t of TRACKED_TABLES) {
      const r = await pool.query<{ n: number }>(
        // Identifier is from a hard-coded allowlist, so interpolation is safe.
        `SELECT COUNT(*)::bigint AS n FROM ${t}`,
      );
      tableCounts[t] = Number(r.rows[0]?.n ?? 0);
    }

    const mig = await pool.query<{ filename: string; applied_at: string }>(
      `SELECT filename, applied_at::text
         FROM schema_migrations
        ORDER BY filename DESC LIMIT 1`,
    );
    if (mig.rowCount && mig.rowCount > 0) {
      lastMigration = mig.rows[0]!.filename;
      lastMigrationAt = mig.rows[0]!.applied_at;
    }
  } catch {
    /* fall through with connected=false */
  }

  // pg.Pool exposes the live counts as numeric properties.
  const p = pool as unknown as {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  };

  return {
    connected,
    pool_total: p.totalCount,
    pool_idle: p.idleCount,
    pool_waiting: p.waitingCount,
    size_bytes: sizeBytes,
    size_pretty: sizePretty,
    table_counts: tableCounts,
    last_migration: lastMigration,
    last_migration_at: lastMigrationAt,
    ping_ms: pingMs,
  };
}

async function collectStorage(): Promise<StorageMetrics> {
  const attachmentsDir = config.attachmentsDir;
  const backupsDir = await resolveBackupDir();

  const [attach, backups] = await Promise.all([
    dirStats(attachmentsDir),
    dirStats(backupsDir),
  ]);

  return {
    attachments_dir: attachmentsDir,
    attachments_bytes: attach.bytes,
    attachments_count: attach.count,
    backups_dir: backupsDir,
    backups_bytes: backups.bytes,
    backup_count: backups.count,
  };
}

interface DirStats {
  bytes: number;
  count: number;
}

/**
 * Recursive byte/file count. Caps the recursion depth at 4 so we don't
 * walk pathological trees on a slow disk. Missing dirs return zeros.
 */
async function dirStats(dir: string, depth = 0): Promise<DirStats> {
  if (depth > 4) return { bytes: 0, count: 0 };
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { bytes: 0, count: 0 };
  }
  let bytes = 0;
  let count = 0;
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (s.isDirectory()) {
        const sub = await dirStats(p, depth + 1);
        bytes += sub.bytes;
        count += sub.count;
      } else if (s.isFile()) {
        bytes += s.size;
        count++;
      }
    } catch {
      /* path vanished mid-walk; ignore */
    }
  }
  return { bytes, count };
}
