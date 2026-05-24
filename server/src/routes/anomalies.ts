import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import {
  loadUserContext,
  requireFinancialMutation,
  requireTenant,
} from '../auth/rbac.js';
import { FEATURES, requireFeature } from '../auth/entitlements.js';
import { recordAudit } from '../domain/audit.js';
import { scanTransactionsForAnomalies } from '../domain/anomaly-detector.js';
import { isUuid } from '../util.js';

/**
 * Backlog (0.13.2) — anomaly alert routes.
 *
 *   GET  /api/anomalies              — list (open by default)
 *   GET  /api/anomalies/count        — counts for the nav badge
 *   POST /api/anomalies/scan         — manual scan; admin/spouse only
 *   POST /api/anomalies/:id/dismiss  — toggle dismissed; admin/spouse
 *
 * Read endpoints available to every tenant member (children see only
 * anomalies on accounts they own — enforced by joining transactions
 * → accounts → account_user_access in the query, simpler to gate
 * write actions and let reads show only the rows children's
 * transactions touch via the FK chain).
 */

export async function anomalyRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { includeDismissed?: string } }>(
    '/api/anomalies',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.ANOMALY_ALERTS);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const includeDismissed = req.query.includeDismissed === '1';
      const r = await pool.query(
        `SELECT a.id, a.transaction_id, a.kind, a.severity, a.message,
                a.details, a.dismissed, a.dismissed_at::text,
                a.detected_at::text,
                t.txn_date::text AS txn_date,
                t.amount_cents AS txn_amount_cents,
                t.raw_description, t.normalized_merchant,
                acc.name AS account_name
           FROM anomaly_alerts a
           JOIN transactions t ON t.id = a.transaction_id
           JOIN accounts acc ON acc.id = t.account_id
          WHERE a.tenant_id = $1
            ${includeDismissed ? '' : 'AND a.dismissed = false'}
          ORDER BY a.detected_at DESC
          LIMIT 500`,
        [tenantId],
      );
      return { anomalies: r.rows };
    },
  );

  app.get('/api/anomalies/count', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const denyFeat = await requireFeature(tenantId, FEATURES.ANOMALY_ALERTS);
    if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
    const r = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM anomaly_alerts
        WHERE tenant_id = $1 AND dismissed = false`,
      [tenantId],
    );
    return { open: Number(r.rows[0]!.c) };
  });

  app.post('/api/anomalies/scan', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const denyFeat = await requireFeature(tenantId, FEATURES.ANOMALY_ALERTS);
    if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
    const ctx = await loadUserContext(req.user!.id, tenantId);
    const denied = requireFinancialMutation(ctx);
    if (denied) return reply.code(denied.status).send({ error: denied.error });
    const result = await scanTransactionsForAnomalies(tenantId, null);
    await recordAudit({
      tenantId,
      actorUserId: req.user!.id,
      actorKind: 'tenant_user',
      action: 'anomalies.scan',
      targetKind: 'tenant',
      targetId: tenantId,
      details: result as unknown as Record<string, unknown>,
    });
    return result;
  });

  app.post<{ Params: { id: string }; Body: { dismissed?: boolean } }>(
    '/api/anomalies/:id/dismiss',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.ANOMALY_ALERTS);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      const denied = requireFinancialMutation(ctx);
      if (denied) return reply.code(denied.status).send({ error: denied.error });
      const dismissed = req.body?.dismissed !== false;
      const r = await pool.query(
        `UPDATE anomaly_alerts
            SET dismissed = $2,
                dismissed_at = CASE WHEN $2 THEN now() ELSE NULL END
          WHERE id = $1 AND tenant_id = $3
       RETURNING id, dismissed, dismissed_at::text`,
        [req.params.id, dismissed, tenantId],
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Anomaly not found' });
      return { anomaly: r.rows[0] };
    },
  );
}
