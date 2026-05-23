import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  type FuelGrade,
  listFuelPrices,
  refreshFromEia,
  setManualFuelPrice,
} from '../domain/fuel-prices.js';

const GRADES: FuelGrade[] = ['regular', 'midgrade', 'premium', 'diesel'];

export async function fuelPriceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/fuel-prices', async () => {
    const prices = await listFuelPrices();
    return {
      prices,
      eiaConfigured: Boolean(config.eiaApiKey),
    };
  });

  app.post('/api/fuel-prices', async (req, reply) => {
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

  app.post('/api/fuel-prices/refresh', async () => {
    const summary = await refreshFromEia();
    return { summary };
  });
}
