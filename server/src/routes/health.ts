import type { FastifyInstance } from 'fastify';
import { collectHealth } from '../domain/health.js';
import { metricsRecorder } from '../domain/metrics-recorder.js';

/**
 * GET /api/health/metrics
 *   Snapshot of app + db + storage state (HealthSnapshot in
 *   domain/health.ts).
 *
 * GET /api/health/timeseries[?window=N]
 *   Rolling buffer of MetricSamples — last `window` seconds, or the
 *   full hour-long buffer when window is missing. Each sample is one
 *   5-second window with CPU, memory, event-loop delay, request rate,
 *   error rate, and DB query rate + latency.
 *
 * GET /api/health/live
 *   The most recent MetricSample by itself — handy for gauge widgets
 *   that don't want to chart history.
 */

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health/metrics', async () => {
    const snapshot = await collectHealth();
    return snapshot;
  });

  app.get<{ Querystring: { window?: string } }>(
    '/api/health/timeseries',
    async (req) => {
      const windowSec = Number(req.query.window) || 0;
      const points = metricsRecorder.getTimeseries(
        windowSec > 0 ? windowSec : undefined,
      );
      return { window_seconds: windowSec, points };
    },
  );

  app.get('/api/health/live', async () => {
    const latest = metricsRecorder.latest();
    return { latest };
  });
}
