import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';

const COLUMNS = `id, name, fuel_type,
  mpg::float8 AS mpg,
  kwh_per_mile::float8 AS kwh_per_mile,
  electricity_rate_cents_per_kwh,
  weekly_avg_miles::float8 AS weekly_avg_miles,
  active, created_at`;

const FUEL_TYPES = ['regular', 'midgrade', 'premium', 'diesel', 'electric'] as const;
type FuelType = (typeof FUEL_TYPES)[number];

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function asPositive(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function asNonNegativeInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

interface VehicleBody {
  name?: unknown;
  fuelType?: unknown;
  mpg?: unknown;
  kwhPerMile?: unknown;
  electricityRateCentsPerKwh?: unknown;
  weeklyAvgMiles?: unknown;
  active?: unknown;
}

function validateNew(body: VehicleBody): { ok: true } | { ok: false; error: string } {
  if (asString(body.name) === '') return { ok: false, error: 'name is required' };
  if (!FUEL_TYPES.includes(body.fuelType as FuelType)) {
    return { ok: false, error: `fuelType must be one of: ${FUEL_TYPES.join(', ')}` };
  }
  if (body.fuelType === 'electric') {
    if (asPositive(body.kwhPerMile) === null) {
      return { ok: false, error: 'electric vehicles need kwhPerMile > 0' };
    }
    if (asNonNegativeInt(body.electricityRateCentsPerKwh) === null) {
      return { ok: false, error: 'electric vehicles need electricityRateCentsPerKwh ≥ 0' };
    }
  } else {
    if (asPositive(body.mpg) === null) {
      return { ok: false, error: 'ICE vehicles need mpg > 0' };
    }
  }
  if (asPositive(body.weeklyAvgMiles) === null && Number(body.weeklyAvgMiles) !== 0) {
    return { ok: false, error: 'weeklyAvgMiles must be ≥ 0' };
  }
  return { ok: true };
}

export async function vehicleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/vehicles', async () => {
    const r = await query(
      `SELECT ${COLUMNS} FROM vehicles ORDER BY active DESC, name`,
    );
    return { vehicles: r.rows };
  });

  app.post('/api/vehicles', async (req, reply) => {
    const body = (req.body ?? {}) as VehicleBody;
    const check = validateNew(body);
    if (!check.ok) return reply.code(400).send({ error: check.error });
    const isEv = body.fuelType === 'electric';
    const r = await query(
      `INSERT INTO vehicles
         (name, fuel_type, mpg, kwh_per_mile, electricity_rate_cents_per_kwh,
          weekly_avg_miles)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        asString(body.name),
        body.fuelType,
        isEv ? null : asPositive(body.mpg),
        isEv ? asPositive(body.kwhPerMile) : null,
        isEv ? asNonNegativeInt(body.electricityRateCentsPerKwh) : null,
        Number(body.weeklyAvgMiles) || 0,
      ],
    );
    return reply.code(201).send({ vehicle: r.rows[0] });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/vehicles/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid vehicle id' });
      }
      const body = (req.body ?? {}) as VehicleBody;
      const sets: string[] = [];
      const params: unknown[] = [];

      if (body.name !== undefined) {
        const n = asString(body.name);
        if (n === '') return reply.code(400).send({ error: 'name cannot be empty' });
        params.push(n);
        sets.push(`name = $${params.length}`);
      }
      if (body.mpg !== undefined) {
        params.push(body.mpg === null ? null : asPositive(body.mpg));
        sets.push(`mpg = $${params.length}`);
      }
      if (body.kwhPerMile !== undefined) {
        params.push(body.kwhPerMile === null ? null : asPositive(body.kwhPerMile));
        sets.push(`kwh_per_mile = $${params.length}`);
      }
      if (body.electricityRateCentsPerKwh !== undefined) {
        params.push(
          body.electricityRateCentsPerKwh === null
            ? null
            : asNonNegativeInt(body.electricityRateCentsPerKwh),
        );
        sets.push(`electricity_rate_cents_per_kwh = $${params.length}`);
      }
      if (body.weeklyAvgMiles !== undefined) {
        const m = Number(body.weeklyAvgMiles);
        if (!Number.isFinite(m) || m < 0) {
          return reply.code(400).send({ error: 'weeklyAvgMiles must be ≥ 0' });
        }
        params.push(m);
        sets.push(`weekly_avg_miles = $${params.length}`);
      }
      if (body.active !== undefined) {
        params.push(Boolean(body.active));
        sets.push(`active = $${params.length}`);
      }
      if (sets.length === 0) {
        return reply.code(400).send({ error: 'No updates' });
      }
      params.push(req.params.id);
      const r = await query(
        `UPDATE vehicles SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING ${COLUMNS}`,
        params,
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Vehicle not found' });
      }
      return { vehicle: r.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/vehicles/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid vehicle id' });
      }
      const r = await query('DELETE FROM vehicles WHERE id = $1', [req.params.id]);
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Vehicle not found' });
      }
      return reply.code(204).send();
    },
  );
}
