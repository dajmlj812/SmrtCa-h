import type { FastifyInstance } from 'fastify';
import { requireTenant } from '../auth/rbac.js';
import { generateBudgetRecap, getBudgetRecap } from '../domain/budget-recap.js';

/**
 * 0.21.x — budget recap endpoints.
 *
 *   GET  /api/budget-recaps/:month   read (404 if not yet generated)
 *   POST /api/budget-recaps/:month   manual trigger — generates or
 *                                    re-generates and returns
 */
function parseMonth(raw: string): string | null {
  const m = raw.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

export async function budgetRecapRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { month: string } }>(
    '/api/budget-recaps/:month',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const month = parseMonth(req.params.month);
      if (!month) {
        return reply.code(400).send({ error: 'month must be YYYY-MM' });
      }
      const recap = await getBudgetRecap(tenantId, month);
      if (!recap) {
        return reply.code(404).send({ error: 'No recap for this month yet' });
      }
      return recap;
    },
  );

  app.post<{ Params: { month: string } }>(
    '/api/budget-recaps/:month',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const month = parseMonth(req.params.month);
      if (!month) {
        return reply.code(400).send({ error: 'month must be YYYY-MM' });
      }
      try {
        const recap = await generateBudgetRecap(tenantId, month);
        return recap;
      } catch (e) {
        return reply
          .code(500)
          .send({ error: e instanceof Error ? e.message : 'recap failed' });
      }
    },
  );
}
