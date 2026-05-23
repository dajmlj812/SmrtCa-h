import type { FastifyInstance } from 'fastify';
import {
  clearRatesFor,
  getDisplayCurrency,
  listRates,
  refreshRatesFromOpenErApi,
  setManualRate,
} from '../domain/fx.js';
import { requireSuperAdmin } from '../auth/rbac.js';

/**
 *   GET    /api/exchange-rates                — list latest rate per pair
 *   POST   /api/exchange-rates/refresh        — pull fresh rates from the provider
 *   POST   /api/exchange-rates                — set a manual override
 *   DELETE /api/exchange-rates/:from/:to      — drop all rows for a pair
 *
 * Reading is open to any authenticated tenant user — the dashboard
 * needs them. Writes are super-admin only (rates are platform-level).
 */

export async function exchangeRatesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/exchange-rates', async (req) => {
    if (!req.user) {
      // Unauth callers see nothing; route is still gated by the global
      // auth preHandler — this branch is a belt-and-suspenders return.
      return { rates: [], display_currency: 'USD' };
    }
    const [rates, display] = await Promise.all([
      listRates(),
      getDisplayCurrency(),
    ]);
    return { rates, display_currency: display };
  });

  app.post('/api/exchange-rates/refresh', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    try {
      const result = await refreshRatesFromOpenErApi();
      return result;
    } catch (err) {
      return reply.code(502).send({
        error: err instanceof Error ? err.message : 'FX refresh failed',
      });
    }
  });

  app.post('/api/exchange-rates', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const body = (req.body ?? {}) as {
      fromCurrency?: unknown;
      toCurrency?: unknown;
      rate?: unknown;
    };
    if (
      typeof body.fromCurrency !== 'string' ||
      typeof body.toCurrency !== 'string'
    ) {
      return reply.code(400).send({ error: 'fromCurrency and toCurrency required' });
    }
    const rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      return reply.code(400).send({ error: 'rate must be a positive number' });
    }
    try {
      const row = await setManualRate(body.fromCurrency, body.toCurrency, rate);
      return reply.code(201).send({ rate: row });
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Invalid rate',
      });
    }
  });

  app.delete<{ Params: { from: string; to: string } }>(
    '/api/exchange-rates/:from/:to',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      const removed = await clearRatesFor(req.params.from, req.params.to);
      return { removed };
    },
  );
}
