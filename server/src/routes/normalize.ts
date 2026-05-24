import type { FastifyInstance } from 'fastify';
import { getProviderId } from '../ai/factory.js';
import { countPendingTransactions, normalizePending } from '../ai/normalize-service.js';
import { assertAccountInTenant, requireTenant } from '../auth/rbac.js';
import { FEATURES, requireFeature } from '../auth/entitlements.js';
import { isUuid } from '../util.js';

/**
 * 0.14.4 — tenant-scoped. Pre-fix `normalizePending` had no tenant
 * concept and would happily walk every household's pending
 * transactions on any /api/normalize call. The route now requires
 * a tenant, verifies `accountId` ownership when supplied, and
 * forwards `tenantId` into the service so the SELECT joins through
 * accounts.
 */
export async function normalizeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ai/status', async () => ({ provider: getProviderId() }));

  // 0.17.4 — pending count for the progress-bar denominator.
  // Same tenant-scoping + optional accountId filter as the
  // normalize route itself.
  app.get<{ Querystring: { accountId?: string } }>(
    '/api/normalize/pending-count',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      let accountId: string | undefined;
      if (req.query.accountId !== undefined && req.query.accountId !== '') {
        if (!isUuid(req.query.accountId)) {
          return reply.code(400).send({ error: 'Invalid accountId' });
        }
        const ok = await assertAccountInTenant(tenantId, req.query.accountId);
        if (!ok) return reply.code(404).send({ error: 'Account not found' });
        accountId = req.query.accountId;
      }
      const count = await countPendingTransactions(tenantId, accountId);
      return { pending: count };
    },
  );

  app.post('/api/normalize', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    // 0.15.2: AI normalize is a Plus+ feature (vendor pays for the
    // LLM call). Starter still uses the local rules-based normalizer
    // via the existing AI_PROVIDER=rules config path.
    const deny = await requireFeature(tenantId, FEATURES.AI_NORMALIZE);
    if (deny) return reply.code(deny.status).send({ error: deny.error });
    const body = (req.body ?? {}) as Record<string, unknown>;

    let accountId: string | undefined;
    if (body.accountId !== undefined && body.accountId !== null) {
      if (typeof body.accountId !== 'string' || !isUuid(body.accountId)) {
        return reply.code(400).send({ error: 'Invalid accountId' });
      }
      const ok = await assertAccountInTenant(tenantId, body.accountId);
      if (!ok) return reply.code(404).send({ error: 'Account not found' });
      accountId = body.accountId;
    }

    let limit: number | undefined;
    if (body.limit !== undefined && body.limit !== null) {
      const n = Number(body.limit);
      if (!Number.isFinite(n) || n <= 0) {
        return reply.code(400).send({ error: 'Invalid limit' });
      }
      limit = Math.floor(n);
    }

    const summary = await normalizePending({
      tenantId,
      ...(accountId ? { accountId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { summary };
  });
}
