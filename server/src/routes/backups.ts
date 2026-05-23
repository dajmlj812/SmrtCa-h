import type { FastifyInstance } from 'fastify';
import {
  deleteBackup,
  listBackups,
  pruneOldBackups,
  resolveBackupDir,
  runBackup,
} from '../domain/backup-runner.js';
import { getEffectiveValue } from '../domain/settings.js';
import { isUuid } from '../util.js';
import { requireSuperAdmin } from '../auth/rbac.js';

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
    const [enabled, frequency, time, retention, dir] = await Promise.all([
      getEffectiveValue('BACKUP_ENABLED'),
      getEffectiveValue('BACKUP_FREQUENCY'),
      getEffectiveValue('BACKUP_TIME'),
      getEffectiveValue('BACKUP_RETENTION_DAYS'),
      getEffectiveValue('BACKUP_DIR'),
    ]);
    const resolvedDir = await resolveBackupDir();
    return {
      enabled: enabled.toLowerCase() === 'true',
      frequency: frequency || 'daily',
      time: time || '03:00',
      retention_days: Number(retention || '30') || 30,
      directory: dir || resolvedDir,
      resolved_directory: resolvedDir,
    };
  });

  app.post('/api/backups/run', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const backup = await runBackup({ kind: 'manual' });
    return { backup };
  });

  app.post('/api/backups/prune', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const retention =
      Number(await getEffectiveValue('BACKUP_RETENTION_DAYS')) || 30;
    const removed = await pruneOldBackups(retention);
    return { removed };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/backups/:id',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid backup id' });
      const ok = await deleteBackup(req.params.id);
      if (!ok) return reply.code(404).send({ error: 'Backup not found' });
      return reply.code(204).send();
    },
  );
}
