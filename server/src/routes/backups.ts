import type { FastifyInstance } from 'fastify';
import {
  deleteBackup,
  listBackups,
  pruneOldBackups,
  resolveBackupDir,
  restoreFromBackup,
  runBackup,
} from '../domain/backup-runner.js';
import { getEffectiveValue } from '../domain/settings.js';
import { isUuid } from '../util.js';
import { requireSuperAdmin } from '../auth/rbac.js';
import { recordAudit } from '../domain/audit.js';

/**
 * Backup management routes for the /backups page.
 *
 *   GET    /api/backups                — list recent backups
 *   GET    /api/backups/config         — current schedule + storage path
 *   POST   /api/backups/run            — fire a manual backup synchronously
 *   POST   /api/backups/prune          — prune anything older than retention
 *   DELETE /api/backups/:id            — remove an on-disk backup
 *
 * The schedule itself lives in app_settings (BACKUP_*); use the existing
 * /api/settings endpoints to mutate it. This file only reads them so the
 * page can render the current effective config alongside the history.
 */

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/backups', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const backups = await listBackups(50);
    return { backups };
  });

  app.get('/api/backups/config', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const [enabled, frequency, time, retention, dir, secondary] = await Promise.all([
      getEffectiveValue('BACKUP_ENABLED'),
      getEffectiveValue('BACKUP_FREQUENCY'),
      getEffectiveValue('BACKUP_TIME'),
      getEffectiveValue('BACKUP_RETENTION_DAYS'),
      getEffectiveValue('BACKUP_DIR'),
      getEffectiveValue('BACKUP_SECONDARY_DIR'),
    ]);
    const resolvedDir = await resolveBackupDir();
    return {
      enabled: enabled.toLowerCase() === 'true',
      frequency: frequency || 'daily',
      time: time || '03:00',
      retention_days: Number(retention || '30') || 30,
      directory: dir || resolvedDir,
      resolved_directory: resolvedDir,
      secondary_directory: secondary,
    };
  });

  app.post('/api/backups/run', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const backup = await runBackup({ kind: 'manual' });
    await recordAudit({
      actorUserId: req.user?.id ?? null,
      actorKind: 'super_admin',
      action: 'backup.run',
      targetKind: 'backup',
      targetId: backup.id,
      details: {
        status: backup.status,
        db_bytes: backup.db_bytes,
        total_bytes: backup.total_bytes,
      },
    });
    return { backup };
  });

  app.post('/api/backups/prune', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const retention =
      Number(await getEffectiveValue('BACKUP_RETENTION_DAYS')) || 30;
    const removed = await pruneOldBackups(retention);
    await recordAudit({
      actorUserId: req.user?.id ?? null,
      actorKind: 'super_admin',
      action: 'backup.prune',
      details: { retentionDays: retention, removed },
    });
    return { removed };
  });

  app.post<{ Params: { id: string }; Body: { confirm?: string } }>(
    '/api/backups/:id/restore',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid backup id' });
      // Strong confirmation: the client must echo the literal string
      // 'RESTORE' so a stray double-click on a row doesn't wipe the
      // database. The UI prompts for it.
      const body = (req.body ?? {}) as { confirm?: string };
      if (body.confirm !== 'RESTORE') {
        return reply.code(400).send({
          error:
            "Restore requires { confirm: 'RESTORE' } in the body — this operation destructively overwrites the current database",
        });
      }
      try {
        const result = await restoreFromBackup(req.params.id);
        // Audit BEFORE returning — the restore overwrites everything
        // including audit_log. The fresh DB will have this entry as
        // one of the first rows, marking the recovery point in time.
        await recordAudit({
          actorUserId: req.user?.id ?? null,
          actorKind: 'super_admin',
          action: 'backup.restore',
          targetKind: 'backup',
          targetId: req.params.id,
          details: result as unknown as Record<string, unknown>,
        });
        return result;
      } catch (err) {
        await recordAudit({
          actorUserId: req.user?.id ?? null,
          actorKind: 'super_admin',
          action: 'backup.restore_failed',
          targetKind: 'backup',
          targetId: req.params.id,
          details: { error: err instanceof Error ? err.message : 'unknown' },
        });
        return reply.code(500).send({
          error: err instanceof Error ? err.message : 'Restore failed',
        });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/backups/:id',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid backup id' });
      const ok = await deleteBackup(req.params.id);
      if (!ok) return reply.code(404).send({ error: 'Backup not found' });
      await recordAudit({
        actorUserId: req.user?.id ?? null,
        actorKind: 'super_admin',
        action: 'backup.deleted',
        targetKind: 'backup',
        targetId: req.params.id,
      });
      return reply.code(204).send();
    },
  );
}
