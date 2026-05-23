import type { FastifyInstance } from 'fastify';
import { getReport, listReports } from '../domain/reports.js';

/**
 *   GET  /api/reports                 — list canned report definitions
 *   POST /api/reports/:id/run         — execute one with parameters
 *
 * Parameters travel in the JSON body keyed by param name. Unknown ids
 * yield 404; unknown params on a known report are ignored.
 */

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/reports', async () => ({ reports: listReports() }));

  app.post<{ Params: { id: string } }>(
    '/api/reports/:id/run',
    async (req, reply) => {
      const def = getReport(req.params.id);
      if (!def) return reply.code(404).send({ error: 'Unknown report id' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string') params[k] = v;
        else if (typeof v === 'number') params[k] = String(v);
      }
      try {
        const result = await def.run(params);
        return { id: def.id, label: def.label, result };
      } catch (err) {
        return reply.code(500).send({
          error: err instanceof Error ? err.message : 'Report execution failed',
        });
      }
    },
  );
}
