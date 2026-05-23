import type { FastifyInstance } from 'fastify';
import { collectHealth } from '../domain/health.js';

/**
 * GET /api/health/metrics
 *
 * Live snapshot of app + db + storage metrics for the /health page.
 * The shape is documented in domain/health.ts (HealthSnapshot).
 */

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health/metrics', async () => {
    const snapshot = await collectHealth();
    return snapshot;
  });
}
