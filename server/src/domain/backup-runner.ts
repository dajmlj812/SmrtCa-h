import { execFile } from 'node:child_process';
import { writeFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { getEffectiveValue, KNOWN_SETTINGS } from './settings.js';

/**
 * In-process backup runner. Produces the same layout as
 * scripts/backup.mjs (a single timestamped directory containing
 * `db.dump` + optional `attachments.tgz`) so a backup made via the GUI
 * is restorable with the existing scripts/restore.mjs.
 *
 * - `runBackup({ kind })` writes the artifact, records a row in `backups`,
 *   and prunes anything older than the retention setting.
 * - The scheduler (in backup-scheduler.ts) calls this on its tick.
 *
 * Designed to be safe when called concurrently — never deletes a backup
 * row mid-run, and tolerates an already-existing target directory.
 */

const exec = promisify(execFile);

export interface BackupRecord {
  id: string;
  kind: 'manual' | 'scheduled';
  status: 'running' | 'success' | 'failed' | 'deleted';
  started_at: string;
  finished_at: string | null;
  path: string;
  db_bytes: number | null;
  attachments_bytes: number | null;
  total_bytes: number | null;
  error: string | null;
}

export interface RunBackupInput {
  kind: 'manual' | 'scheduled';
}

const COLUMNS = `id, kind, status, started_at::text, finished_at::text,
  path, db_bytes, attachments_bytes, total_bytes, error`;

/**
 * Resolve the backup output directory. Honors the BACKUP_DIR setting,
 * else falls back to <data root>/backups (sibling of attachments). The
 * /data root in the Docker image is `/data`; in dev it's <repo>/data.
 */
export async function resolveBackupDir(): Promise<string> {
  const cfgPath = (await getEffectiveValue('BACKUP_DIR')).trim();
  if (cfgPath) return resolve(cfgPath);
  // Default: sibling of attachments. attachmentsDir = .../data/attachments
  // → backupDir = .../data/backups.
  return resolve(dirname(config.attachmentsDir), 'backups');
}

export async function listBackups(limit = 50): Promise<BackupRecord[]> {
  const r = await query<BackupRecord>(
    `SELECT ${COLUMNS} FROM backups
      WHERE status <> 'deleted'
      ORDER BY started_at DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function getBackup(id: string): Promise<BackupRecord | null> {
  const r = await query<BackupRecord>(
    `SELECT ${COLUMNS} FROM backups WHERE id = $1`,
    [id],
  );
  return r.rowCount && r.rowCount > 0 ? r.rows[0]! : null;
}

/**
 * Build the env-snapshot payload that ships inside a backup.
 *
 * Exported so the unit test can verify the security contract — never
 * write a secret-class env var to disk — without spinning up a full
 * backup run. Pure: depends only on KNOWN_SETTINGS and the env source
 * passed in.
 *
 * F-13 (security audit 2026-05-25): a leaked backup file used to give
 * the holder SESSION_SECRET (forge any session), ATTACHMENT_ENCRYPTION_KEY
 * (unwrap every tenant's DEK and decrypt receipts + Plaid tokens), and
 * STRIPE_SECRET_KEY (full Stripe account access). Now we exclude every
 * KNOWN_SETTINGS entry marked isSecret:true. Operators must re-provision
 * secrets from a separate secret-management process on restore.
 */
export function buildEnvSnapshot(envSource: NodeJS.ProcessEnv): {
  envSnapshot: Record<string, string>;
  omittedSecrets: string[];
} {
  const envSnapshot: Record<string, string> = {};
  const omittedSecrets: string[] = [];
  for (const m of KNOWN_SETTINGS) {
    if (m.isSecret) {
      omittedSecrets.push(m.key);
      continue;
    }
    const v = envSource[m.key];
    if (v !== undefined && v !== '') envSnapshot[m.key] = v;
  }
  return { envSnapshot, omittedSecrets };
}

/**
 * Run a backup synchronously (caller awaits). Records timing + sizes +
 * any failure on the `backups` row.
 */
export async function runBackup(input: RunBackupInput): Promise<BackupRecord> {
  const root = await resolveBackupDir();
  await mkdir(root, { recursive: true });

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/T/, '_')
    .slice(0, 19);
  const backupPath = join(root, ts);
  await mkdir(backupPath, { recursive: true });

  // 1) Reserve the row up front so the GUI can see in-progress runs.
  const insert = await query<{ id: string; started_at: string }>(
    `INSERT INTO backups (kind, status, path)
     VALUES ($1, 'running', $2)
     RETURNING id, started_at::text`,
    [input.kind, backupPath],
  );
  const id = insert.rows[0]!.id;

  try {
    // 2) pg_dump custom format. Same flags as scripts/backup.mjs so a
    //    backup is restorable with scripts/restore.mjs.
    const dumpFile = join(backupPath, 'db.dump');
    await exec('pg_dump', [
      '--format=custom',
      '--compress=9',
      `--file=${dumpFile}`,
      config.databaseUrl,
    ]);
    const dbBytes = (await stat(dumpFile)).size;

    // 3) Attachments — only if the directory exists and has content.
    let attachmentsBytes = 0;
    const attachmentsDir = config.attachmentsDir;
    const dirStat = await stat(attachmentsDir).catch(() => null);
    if (dirStat?.isDirectory()) {
      const archive = join(backupPath, 'attachments.tgz');
      const parent = dirname(attachmentsDir);
      const base = attachmentsDir.slice(parent.length + 1);
      try {
        await exec('tar', ['--force-local', '-czf', archive, '-C', parent, base]);
        attachmentsBytes = (await stat(archive)).size;
      } catch {
        // tar may not exist on Windows dev — record dbBytes only, don't fail
        // the whole backup over a missing attachment archive.
      }
    }

    // 4) Env snapshot. app_settings rows live INSIDE the pg_dump
    //    (everything in the DB is captured), but env-var fallbacks
    //    (process.env values for KNOWN_SETTINGS keys) are outside the
    //    DB — they live in the .env file on the host. Persist a
    //    sanitized snapshot here so a restore can put them back even
    //    after a full host wipe.
    const envSnapshotPath = join(backupPath, 'env.snapshot.json');
    const { envSnapshot, omittedSecrets } = buildEnvSnapshot(process.env);
    await writeFile(
      envSnapshotPath,
      JSON.stringify(
        {
          captured_at: new Date().toISOString(),
          note:
            'Non-secret env values for KNOWN_SETTINGS at the moment of backup. ' +
            'Secret-class keys (isSecret=true) are intentionally omitted and must be ' +
            're-provisioned by the operator from a separate secret-management process. ' +
            'app_settings rows (including any secrets stored in the DB) are inside db.dump.',
          env: envSnapshot,
          omitted_secret_keys: omittedSecrets,
        },
        null,
        2,
      ),
      'utf8',
    );

    // 5) Optional secondary destination (off-server). When
    //    BACKUP_SECONDARY_DIR is set, mirror the timestamped folder
    //    there. Failure is non-fatal — the primary copy is recorded
    //    successful and the failure shows up in error.
    let secondaryWarning: string | undefined;
    const secondary = (await getEffectiveValue('BACKUP_SECONDARY_DIR')).trim();
    if (secondary !== '') {
      try {
        const secondaryRoot = resolve(secondary);
        await mkdir(secondaryRoot, { recursive: true });
        const dest = join(secondaryRoot, ts);
        await cp(backupPath, dest, { recursive: true });
      } catch (err) {
        secondaryWarning =
          'Primary backup succeeded; secondary copy failed: ' +
          (err instanceof Error ? err.message : String(err));
      }
    }

    const total = dbBytes + attachmentsBytes;
    const r = await query<BackupRecord>(
      `UPDATE backups
          SET status = 'success',
              finished_at = now(),
              db_bytes = $1,
              attachments_bytes = $2,
              total_bytes = $3,
              error = $4
        WHERE id = $5
        RETURNING ${COLUMNS}`,
      [dbBytes, attachmentsBytes, total, secondaryWarning ?? null, id],
    );

    // 0.18.13 — record a capacity snapshot after every successful
    // backup. The backup scheduler runs at least daily on configured
    // instances, so this guarantees the projection always has fresh
    // data. Imported lazily to avoid a circular import (capacity-
    // projector imports collectHealth which references backup-runner).
    void import('./capacity-projector.js')
      .then((m) => m.recordCapacitySnapshot())
      .catch(() => {
        /* best-effort: capacity snapshot failure must never block backup */
      });

    return r.rows[0]!;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const r = await query<BackupRecord>(
      `UPDATE backups
          SET status = 'failed',
              finished_at = now(),
              error = $1
        WHERE id = $2
        RETURNING ${COLUMNS}`,
      [msg.slice(0, 500), id],
    );
    return r.rows[0]!;
  }
}

/**
 * Delete a backup's on-disk artifact and mark the row deleted (kept for
 * audit). Tolerates a missing path so re-deleting is idempotent.
 */
export async function deleteBackup(id: string): Promise<boolean> {
  const found = await getBackup(id);
  if (!found || found.status === 'deleted') return false;
  await rm(found.path, { recursive: true, force: true });
  await query(
    `UPDATE backups SET status = 'deleted' WHERE id = $1`,
    [id],
  );
  return true;
}

/**
 * Prune backups older than `retentionDays`. Run after a successful
 * backup; also exposed for manual maintenance from the GUI.
 */
export async function pruneOldBackups(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const stale = await query<{ id: string; path: string }>(
    `SELECT id, path FROM backups
      WHERE status = 'success'
        AND started_at < now() - make_interval(days => $1::int)`,
    [retentionDays],
  );
  let removed = 0;
  for (const row of stale.rows) {
    try {
      await rm(row.path, { recursive: true, force: true });
    } catch {
      /* path already gone */
    }
    await query(
      `UPDATE backups SET status = 'deleted' WHERE id = $1`,
      [row.id],
    );
    removed++;
  }
  return removed;
}

/**
 * Restore from an existing backup row. Runs `pg_restore --clean
 * --if-exists` against the current DATABASE_URL, then extracts the
 * attachments tar over the configured attachments directory.
 *
 * Destructive. The caller is expected to enforce a strong confirmation
 * flow (the route layer requires a query-param token).
 *
 * Behavior notes:
 *  - Open connections from THIS server stay alive — pg_restore acquires
 *    its own connection to drop+recreate objects. We rely on the new
 *    schema being a strict superset of what's running.
 *  - Env snapshot (env.snapshot.json) is ignored at restore time; the
 *    operator should manually restore .env if they need it. We don't
 *    write to the host filesystem outside the data volume.
 *  - The backup ROW itself is dumped INSIDE db.dump from before the
 *    restore — so after restore, the in-memory id may no longer match
 *    anything in the database. That's by design.
 */
export async function restoreFromBackup(
  id: string,
): Promise<{ ok: true; warnings: string[] }> {
  const found = await getBackup(id);
  if (!found) throw new Error('Backup not found');
  if (found.status !== 'success') {
    throw new Error(`Backup is in status '${found.status}' — only 'success' rows can be restored`);
  }
  const dumpPath = join(found.path, 'db.dump');
  if (!existsSync(dumpPath)) {
    throw new Error(`db.dump is missing at ${dumpPath} — backup files may have been moved`);
  }

  const warnings: string[] = [];

  // 1) pg_restore — destructive, drops every object first.
  await exec('pg_restore', [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    `--dbname=${config.databaseUrl}`,
    dumpPath,
  ]);

  // 2) Attachments — replace the directory with the contents of the tar.
  const archive = join(found.path, 'attachments.tgz');
  if (existsSync(archive)) {
    try {
      const attachmentsDir = config.attachmentsDir;
      await rm(attachmentsDir, { recursive: true, force: true });
      const parent = dirname(attachmentsDir);
      await mkdir(parent, { recursive: true });
      await exec('tar', ['--force-local', '-xzf', archive, '-C', parent]);
    } catch (err) {
      warnings.push(
        'attachments restore failed: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  } else {
    warnings.push('no attachments.tgz in this backup — attachments dir left untouched');
  }

  return { ok: true, warnings };
}

// Small re-export so health.ts doesn't have to know the resolution rule.
export const _internalForTests = { pool };
