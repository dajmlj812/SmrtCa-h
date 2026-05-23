import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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

export interface HealthSnapshot {
  generated_at: string;
  app: AppMetrics;
  db: DbMetrics;
  storage: StorageMetrics;
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
  const [app, db, storage] = await Promise.all([
    collectApp(),
    collectDb(),
    collectStorage(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    app,
    db,
    storage,
  };
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
