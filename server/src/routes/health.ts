import type { FastifyInstance } from 'fastify';
import { collectHealth } from '../domain/health.js';
import { metricsRecorder } from '../domain/metrics-recorder.js';
import { collectSaasMetrics } from '../domain/saas-health.js';
import { projectCapacity } from '../domain/capacity-projector.js';
import { diagnosticsRecorder } from '../domain/diagnostics-recorder.js';
import {
  getCurrentIntervalHours,
  getSchedulerState,
  runManualAnalysis,
} from '../domain/performance-scheduler.js';
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

  // 0.18.13 — capacity projection. Writes a fresh snapshot for today
  // as a side effect (so the next read has one more data point) and
  // returns the bytes-per-day growth + projected "days until 80%/95%
  // full" + a recommended swap-prep date.
  app.get('/api/health/capacity', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    return projectCapacity();
  });

  // 0.18.13 — on-demand log + slow-query feeds. Backed by in-memory
  // ring buffers (see domain/diagnostics-recorder.ts). NOT polled
  // by the health-page auto-refresh; the operator clicks "Refresh"
  // when they want the latest. Querystring `limit` is honored up to
  // the buffer cap.
  app.get<{ Querystring: { limit?: string } }>(
    '/api/health/logs',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      return { entries: diagnosticsRecorder.getLogs(limit) };
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    '/api/health/slow-queries',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      return {
        threshold_ms: diagnosticsRecorder.slowQueryThresholdMs,
        entries: diagnosticsRecorder.getSlowQueries(limit),
      };
    },
  );

  // 0.19.4 — slow-route capture. Same shape as slow-queries; the
  // /health page surfaces both panels side-by-side.
  app.get<{ Querystring: { limit?: string } }>(
    '/api/health/slow-routes',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      return {
        threshold_ms: diagnosticsRecorder.slowRouteThresholdMs,
        entries: diagnosticsRecorder.getSlowRoutes(limit),
      };
    },
  );

  // 0.18.13 — performance recommendations (dynamic).
  //
  // GET returns the latest scheduled-analysis result + scheduler
  // metadata (when the next run will fire, current interval setting).
  // The analyzer runs ~30s after boot, then every
  // PERFORMANCE_ANALYSIS_INTERVAL_HOURS — but the operator can also
  // POST to force an immediate rerun. POST is super-admin only;
  // GET is super-admin only too because the contents leak operational
  // posture (slow queries observed, error rates, etc.).
  app.get('/api/health/performance', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const state = getSchedulerState();
    const intervalHours = await getCurrentIntervalHours();
    return { ...state, interval_hours: intervalHours };
  });

  app.post('/api/health/performance/run', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    await runManualAnalysis();
    const state = getSchedulerState();
    const intervalHours = await getCurrentIntervalHours();
    return { ...state, interval_hours: intervalHours };
  });
}
