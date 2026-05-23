import type { FastifyInstance } from 'fastify';
import { requireSuperAdmin } from '../auth/rbac.js';
import { runAutoSyncTick } from '../domain/auto-sync.js';
import { getEffectiveValue } from '../domain/settings.js';
import { pool } from '../db/pool.js';

/**
 * Phase 8.3 — control surface for the auto-sync scheduler.
 *
 * Two endpoints, both super-admin only:
 *
 *   GET  /api/auto-sync/status   — config + counts of registered sources
 *   POST /api/auto-sync/run      — fire an immediate tick (force=true)
 *
 * Tenant admins still use the per-connection /sync routes for one-off
 * manual fires; this endpoint exists so a super admin can verify the
 * pipeline works without waiting for the cadence to elapse.
 */
export async function autoSyncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auto-sync/status', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;

    const enabled =
      (await getEffectiveValue('AUTO_SYNC_ENABLED')).toLowerCase() === 'true';
    const frequency =
      (await getEffectiveValue('AUTO_SYNC_FREQUENCY')).toLowerCase() || 'daily';
    const time = (await getEffectiveValue('AUTO_SYNC_TIME')) || '03:00';

    const ofxCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ofx_dc_connections WHERE enabled = true`,
    );
    const plaidCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM plaid_items WHERE status = 'active'`,
    );
    return {
      enabled,
      frequency,
      time,
      sources: {
        ofx_dc: Number(ofxCount.rows[0]!.c),
        plaid: Number(plaidCount.rows[0]!.c),
      },
    };
  });

  app.post(
    '/api/auto-sync/run',
    {
      // Ignore an empty JSON body sent by curl-style clients — Fastify
      // would otherwise reject a POST with content-type:json + no body.
      bodyLimit: 1,
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      const result = await runAutoSyncTick({ force: true });
      return result;
    },
  );
}
