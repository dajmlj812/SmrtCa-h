import type { FastifyInstance } from 'fastify';
import { collectHealth } from '../domain/health.js';
import { metricsRecorder } from '../domain/metrics-recorder.js';
import { collectSaasMetrics } from '../domain/saas-health.js';
import { requireSuperAdmin } from '../auth/rbac.js';

/**
 * Health endpoints — super-admin only (Phase 9.1).
 *
 * GET /api/health/metrics
 *   App + db + storage snapshot.
 *
 * GET /api/health/timeseries[?window=N]
 *   Rolling buffer of MetricSamples.
 *
 * GET /api/health/live
 *   The most recent sample.
 *
 * GET /api/health/saas (0.15.5)
 *   Subscription distribution + webhook ingest counts.
 *
 * These were tenant-admin-visible until 0.9.1. They surface operational
 * details (process pids, DB pool, on-disk paths) that don't belong in
 * a tenant's view; super admins manage the platform.
 */

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health/metrics', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    return collectHealth();
  });

  app.get<{ Querystring: { window?: string } }>(
    '/api/health/timeseries',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      const windowSec = Number(req.query.window) || 0;
      const points = metricsRecorder.getTimeseries(
        windowSec > 0 ? windowSec : undefined,
      );
      return { window_seconds: windowSec, points };
    },
  );

  app.get('/api/health/live', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const latest = metricsRecorder.latest();
    return { latest };
  });

  app.get('/api/health/saas', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    return collectSaasMetrics();
  });
}
