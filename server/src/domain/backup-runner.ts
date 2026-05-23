import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { getEffectiveValue } from './settings.js';

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
        await exec('tar', ['-czf', archive, '-C', parent, base]);
        attachmentsBytes = (await stat(archive)).size;
      } catch {
        // tar may not exist on Windows dev — record dbBytes only, don't fail
        // the whole backup over a missing attachment archive.
      }
    }

    const total = dbBytes + attachmentsBytes;
    const r = await query<BackupRecord>(
      `UPDATE backups
          SET status = 'success',
              finished_at = now(),
              db_bytes = $1,
              attachments_bytes = $2,
              total_bytes = $3
        WHERE id = $4
        RETURNING ${COLUMNS}`,
      [dbBytes, attachmentsBytes, total, id],
    );
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

// Small re-export so health.ts doesn't have to know the resolution rule.
export const _internalForTests = { pool };
