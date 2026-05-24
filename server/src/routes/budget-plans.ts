import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { requireTenant } from '../auth/rbac.js';

/**
 * 0.17.16 — budget plans CRUD. A plan is one paycheck-to-
 * paycheck cycle: name + cadence + anchor + the accounts it
 * scopes. The wizard creates these implicitly on commit; this
 * route exists so the UI can list them, rename them, and
 * delete them. Each delete cascades to the plan's per-period
 * `budgets` rows via FK.
 */

interface PlanRow {
  id: string;
  name: string;
  period_type: string;
  anchor_date: string;
  account_ids: string[];
  created_at: string;
}

export async function budgetPlansRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/budget-plans', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const r = await query<PlanRow>(
      `SELECT id, name, period_type,
              to_char(anchor_date, 'YYYY-MM-DD') AS anchor_date,
              account_ids,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM budget_plans
        WHERE tenant_id = $1
     ORDER BY created_at`,
      [tenantId],
    );
    return { plans: r.rows };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/budget-plans/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid plan id' });
      }
      const r = await pool.query(
        'DELETE FROM budget_plans WHERE id = $1 AND tenant_id = $2',
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Plan not found' });
      }
      return reply.code(204).send();
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    '/api/budget-plans/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid plan id' });
      }
      const name =
        typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) return reply.code(400).send({ error: 'name is required' });
      try {
        const r = await query<PlanRow>(
          `UPDATE budget_plans SET name = $1
            WHERE id = $2 AND tenant_id = $3
        RETURNING id, name, period_type,
                  to_char(anchor_date, 'YYYY-MM-DD') AS anchor_date,
                  account_ids,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`,
          [name, req.params.id, tenantId],
        );
        if (r.rowCount === 0) {
          return reply.code(404).send({ error: 'Plan not found' });
        }
        return { plan: r.rows[0] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Rename failed';
        if (msg.includes('budget_plans_tenant_id_name_key')) {
          return reply.code(409).send({ error: 'A plan with that name already exists' });
        }
        throw e;
      }
    },
  );
}
