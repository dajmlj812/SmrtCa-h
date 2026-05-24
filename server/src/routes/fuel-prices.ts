import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  type FuelGrade,
  listFuelPrices,
  refreshFromEia,
  setManualFuelPrice,
} from '../domain/fuel-prices.js';
import {
  loadUserContext,
  requireFinancialMutation,
  requireTenant,
} from '../auth/rbac.js';

const GRADES: FuelGrade[] = ['regular', 'midgrade', 'premium', 'diesel'];

/**
 * 0.14.4 — fuel-prices design note.
 *
 * `fuel_prices.fuel_type` is the PRIMARY KEY, so there's ONE row per
 * grade across the whole database — these are global reference values
 * (US national average from EIA), just like `exchange_rates`. The
 * column `fuel_prices.tenant_id` added in Phase 8 is effectively
 * unused.
 *
 * Two consequences for the hardening pass:
 *   1. No per-tenant scoping needed on reads — every tenant sees the
 *      same prices, and that's correct.
 *   2. Writes (POST manual override, refresh from EIA) affect every
 *      tenant. So we gate them on financial-mutation role (admin or
 *      spouse) — children can't change shared prices.
 *
 * Super-admin sessions (no active tenant) still get 403 for
 * consistency with the rest of the hardening pass; they should use
 * the system console for global config, not /api/fuel-prices.
 */
export async function fuelPriceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/fuel-prices', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const prices = await listFuelPrices();
    return {
      prices,
      eiaConfigured: Boolean(config.eiaApiKey),
    };
  });

  app.post('/api/fuel-prices', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const ctx = await loadUserContext(req.user!.id, tenantId);
    const denied = requireFinancialMutation(ctx);
    if (denied) return reply.code(denied.status).send({ error: denied.error });

    const body = (req.body ?? {}) as {
      fuelType?: unknown;
      priceCentsPerGallon?: unknown;
    };
    if (!GRADES.includes(body.fuelType as FuelGrade)) {
      return reply.code(400).send({
        error: `fuelType must be one of: ${GRADES.join(', ')}`,
      });
    }
    const n = Number(body.priceCentsPerGallon);
    if (!Number.isInteger(n) || n < 0) {
      return reply
        .code(400)
        .send({ error: 'priceCentsPerGallon must be a non-negative integer' });
    }
    try {
      const row = await setManualFuelPrice(body.fuelType as FuelGrade, n);
      return reply.code(201).send({ price: row });
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to save',
      });
    }
  });

  app.post('/api/fuel-prices/refresh', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const ctx = await loadUserContext(req.user!.id, tenantId);
    const denied = requireFinancialMutation(ctx);
    if (denied) return reply.code(denied.status).send({ error: denied.error });
    const summary = await refreshFromEia();
    return { summary };
  });
}
