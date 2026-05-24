import type { FastifyInstance } from 'fastify';
import { getReport, listReports } from '../domain/reports.js';
import { requireTenant } from '../auth/rbac.js';

/**
 *   GET  /api/reports                 — list canned report definitions
 *   POST /api/reports/:id/run         — execute one with parameters
 *
 * Parameters travel in the JSON body keyed by param name. Unknown ids
 * yield 404; unknown params on a known report are ignored.
 *
 * 0.14.2 — both routes require an active tenant; the tenantId is
 * threaded into every report's `run()` so each report's SQL filters
 * by it. The catalog itself (list) is public to any logged-in user
 * but still gated on tenant presence so a freshly-created user
 * with no membership doesn't see the routes work.
 */

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/reports', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    return { reports: listReports() };
  });

  app.post<{ Params: { id: string } }>(
    '/api/reports/:id/run',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const def = getReport(req.params.id);
      if (!def) return reply.code(404).send({ error: 'Unknown report id' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string') params[k] = v;
        else if (typeof v === 'number') params[k] = String(v);
      }
      try {
        const result = await def.run(params, tenantId);
        return { id: def.id, label: def.label, result };
      } catch (err) {
        return reply.code(500).send({
          error: err instanceof Error ? err.message : 'Report execution failed',
        });
      }
    },
  );
}
