import type { FastifyInstance } from 'fastify';
import { getProviderId } from '../ai/factory.js';
import { normalizePending } from '../ai/normalize-service.js';
import { isUuid } from '../util.js';

export async function normalizeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ai/status', async () => ({ provider: getProviderId() }));

  app.post('/api/normalize', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    let accountId: string | undefined;
    if (body.accountId !== undefined && body.accountId !== null) {
      if (typeof body.accountId !== 'string' || !isUuid(body.accountId)) {
        return reply.code(400).send({ error: 'Invalid accountId' });
      }
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

    const summary = await normalizePending({ accountId, limit });
    return { summary };
  });
}
