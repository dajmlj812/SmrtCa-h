import type { FastifyInstance } from 'fastify';
import { getProviderId } from '../ai/factory.js';
import { AIProviderNotConfiguredError } from '../ai/errors.js';
import {
  countByNormalizationStatus,
  countPendingTransactions,
  normalizePending,
} from '../ai/normalize-service.js';
import { assertAccountInTenant, requireTenant } from '../auth/rbac.js';
import {
  FEATURES,
  checkAndIncrementQuota,
  requireFeature,
} from '../auth/entitlements.js';
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

  // 0.17.5 — richer count powering the "Re-normalize already-
  // normalized too?" prompt. Single round-trip GROUP BY across
  // every status.
  app.get<{ Querystring: { accountId?: string } }>(
    '/api/normalize/counts',
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
      return countByNormalizationStatus(tenantId, accountId);
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

    // 0.17.5 — mode controls which rows the service touches.
    // Default 'pending' = original behavior. 'all' lets the user
    // re-normalize already-normalized rows (e.g. after switching
    // AI providers). 'manual' rows are NEVER touched in either
    // mode — those are user choices the AI doesn't override.
    let mode: 'pending' | 'all' = 'pending';
    if (body.mode !== undefined && body.mode !== null) {
      if (body.mode !== 'pending' && body.mode !== 'all') {
        return reply
          .code(400)
          .send({ error: 'mode must be "pending" or "all"' });
      }
      mode = body.mode;
    }

    // 0.17.5 — meter the call against the AI_ASSISTANT quota.
    // Every normalize batch makes `limit` LLM calls (one per
    // transaction) to the AI provider; that's the same compute
    // cost as a chat message and should count against the same
    // monthly cap. The /billing meter was stuck at 0 before this
    // because the normalize route didn't touch the counter at
    // all — only /api/assistant/chat did. For Family (unlimited)
    // tenants the counter still ticks via bumpCounter so usage is
    // visible on /billing.
    const charge = limit ?? 1; // server caps at 2000 internally
    const quota = await checkAndIncrementQuota(
      tenantId,
      FEATURES.AI_ASSISTANT,
      charge,
    );
    if (!quota.granted) {
      return reply
        .code(quota.denial!.status)
        .send({ error: quota.denial!.error });
    }

    // 0.19.1.x — AI-provider misconfig (missing API key, etc.) is an
    // operator condition the tenant user can't fix. Surface it as a
    // 503 with a clear message rather than a raw 500.
    try {
      const summary = await normalizePending({
        tenantId,
        ...(accountId ? { accountId } : {}),
        ...(limit !== undefined ? { limit } : {}),
        mode,
      });
      return { summary };
    } catch (err) {
      if (err instanceof AIProviderNotConfiguredError) {
        return reply.code(503).send({
          error: err.message,
          code: err.code,
          missingSetting: err.missingSetting,
        });
      }
      throw err;
    }
  });
}
