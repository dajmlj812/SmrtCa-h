import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { requireTenant } from '../auth/rbac.js';

/**
 * 0.21.0 — IRS-compliant mileage log.
 *
 * Backs the tax export's Schedule C "Car and truck expenses" line
 * (line 9) and the mileage CSV download. Trips are date-stamped so
 * /api/reports/tax-year/:year can aggregate by purpose for the
 * requested year.
 *
 * Standard mileage rates (cents/mile) live in MILEAGE_RATES below.
 * Update yearly when the IRS publishes new rates.
 */

export type MileagePurpose =
  | 'business'
  | 'commute'
  | 'charity'
  | 'medical'
  | 'moving'
  | 'personal';

const PURPOSES: MileagePurpose[] = [
  'business',
  'commute',
  'charity',
  'medical',
  'moving',
  'personal',
];

/**
 * IRS standard mileage rates in cents per mile, by tax year.
 *
 * Each entry covers Jan 1 – Dec 31 of the keyed year. Mid-year
 * rate splits (2022 had one) are not modeled — picking the
 * higher half-year rate here is a known imprecision; consult a
 * tax professional for ambiguous years.
 */
export const MILEAGE_RATES: Record<
  number,
  { business: number; charity: number; medical: number }
> = {
  2022: { business: 62.5, charity: 14, medical: 22 },
  2023: { business: 65.5, charity: 14, medical: 22 },
  2024: { business: 67, charity: 14, medical: 21 },
  2025: { business: 70, charity: 14, medical: 21 },
  2026: { business: 70, charity: 14, medical: 21 },
};

const LATEST_RATES = MILEAGE_RATES[2026]!;

export function mileageRatesForYear(year: number): {
  business: number;
  charity: number;
  medical: number;
  moving: number;
  commute: number;
  personal: number;
} {
  const base = MILEAGE_RATES[year] ?? LATEST_RATES;
  return {
    business: base.business,
    charity: base.charity,
    medical: base.medical,
    // Moving is deductible only for active-duty military since TCJA
    // (2018); we keep a rate slot for parity with the medical rate.
    moving: base.medical,
    commute: 0,
    personal: 0,
  };
}

const TRIP_COLUMNS = `
  id, vehicle_id, trip_date, purpose,
  miles::float8 AS miles,
  start_odometer::float8 AS start_odometer,
  end_odometer::float8 AS end_odometer,
  start_location, end_location, description, created_at`;

interface TripInput {
  vehicleId: string | null;
  tripDate: string;
  purpose: MileagePurpose;
  miles: number;
  startOdometer: number | null;
  endOdometer: number | null;
  startLocation: string | null;
  endLocation: string | null;
  description: string | null;
}

function parseTrip(body: unknown): TripInput | string {
  if (!body || typeof body !== 'object') return 'body required';
  const b = body as Record<string, unknown>;
  let vehicleId: string | null = null;
  if (b.vehicleId !== undefined && b.vehicleId !== null) {
    if (typeof b.vehicleId !== 'string' || !isUuid(b.vehicleId)) {
      return 'vehicleId must be a UUID or null';
    }
    vehicleId = b.vehicleId;
  }
  if (typeof b.tripDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.tripDate)) {
    return 'tripDate must be YYYY-MM-DD';
  }
  if (typeof b.purpose !== 'string' || !(PURPOSES as string[]).includes(b.purpose)) {
    return `purpose must be one of ${PURPOSES.join(', ')}`;
  }
  const miles = Number(b.miles);
  if (!Number.isFinite(miles) || miles < 0) return 'miles must be >= 0';
  const startOdo = b.startOdometer === undefined || b.startOdometer === null
    ? null
    : Number(b.startOdometer);
  if (startOdo !== null && (!Number.isFinite(startOdo) || startOdo < 0)) {
    return 'startOdometer must be >= 0 or null';
  }
  const endOdo = b.endOdometer === undefined || b.endOdometer === null
    ? null
    : Number(b.endOdometer);
  if (endOdo !== null && (!Number.isFinite(endOdo) || endOdo < 0)) {
    return 'endOdometer must be >= 0 or null';
  }
  if (startOdo !== null && endOdo !== null && endOdo < startOdo) {
    return 'endOdometer must be >= startOdometer';
  }
  return {
    vehicleId,
    tripDate: b.tripDate,
    purpose: b.purpose as MileagePurpose,
    miles,
    startOdometer: startOdo,
    endOdometer: endOdo,
    startLocation: typeof b.startLocation === 'string' && b.startLocation.trim()
      ? b.startLocation.trim()
      : null,
    endLocation: typeof b.endLocation === 'string' && b.endLocation.trim()
      ? b.endLocation.trim()
      : null,
    description: typeof b.description === 'string' && b.description.trim()
      ? b.description.trim()
      : null,
  };
}

async function vehicleInTenant(tenantId: string, vehicleId: string): Promise<boolean> {
  const r = await pool.query(
    'SELECT 1 FROM vehicles WHERE id = $1 AND tenant_id = $2',
    [vehicleId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function mileageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { year?: string; vehicleId?: string; limit?: string } }>(
    '/api/mileage',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const params: unknown[] = [tenantId];
      const where: string[] = ['tenant_id = $1'];
      if (req.query.year) {
        const y = Number(req.query.year);
        if (!Number.isInteger(y)) return reply.code(400).send({ error: 'year must be an integer' });
        params.push(`${y}-01-01`);
        where.push(`trip_date >= $${params.length}`);
        params.push(`${y}-12-31`);
        where.push(`trip_date <= $${params.length}`);
      }
      if (req.query.vehicleId) {
        if (!isUuid(req.query.vehicleId)) {
          return reply.code(400).send({ error: 'vehicleId must be a UUID' });
        }
        params.push(req.query.vehicleId);
        where.push(`vehicle_id = $${params.length}`);
      }
      const limit = req.query.limit ? Math.min(Number(req.query.limit) || 500, 2000) : 500;
      params.push(limit);
      const r = await query(
        `SELECT ${TRIP_COLUMNS} FROM mileage_log
          WHERE ${where.join(' AND ')}
          ORDER BY trip_date DESC, created_at DESC
          LIMIT $${params.length}`,
        params,
      );
      return { trips: r.rows };
    },
  );

  app.post('/api/mileage', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const parsed = parseTrip(req.body);
    if (typeof parsed === 'string') return reply.code(400).send({ error: parsed });
    if (parsed.vehicleId && !(await vehicleInTenant(tenantId, parsed.vehicleId))) {
      return reply.code(400).send({ error: 'vehicleId not found' });
    }
    const r = await query(
      `INSERT INTO mileage_log
         (tenant_id, vehicle_id, trip_date, purpose, miles,
          start_odometer, end_odometer, start_location, end_location, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${TRIP_COLUMNS}`,
      [
        tenantId, parsed.vehicleId, parsed.tripDate, parsed.purpose, parsed.miles,
        parsed.startOdometer, parsed.endOdometer,
        parsed.startLocation, parsed.endLocation, parsed.description,
      ],
    );
    return reply.code(201).send({ trip: r.rows[0] });
  });

  app.patch<{ Params: { id: string } }>('/api/mileage/:id', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isUuid(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const parsed = parseTrip(req.body);
    if (typeof parsed === 'string') return reply.code(400).send({ error: parsed });
    if (parsed.vehicleId && !(await vehicleInTenant(tenantId, parsed.vehicleId))) {
      return reply.code(400).send({ error: 'vehicleId not found' });
    }
    const r = await query(
      `UPDATE mileage_log
          SET vehicle_id = $1, trip_date = $2, purpose = $3, miles = $4,
              start_odometer = $5, end_odometer = $6,
              start_location = $7, end_location = $8, description = $9
        WHERE id = $10 AND tenant_id = $11
        RETURNING ${TRIP_COLUMNS}`,
      [
        parsed.vehicleId, parsed.tripDate, parsed.purpose, parsed.miles,
        parsed.startOdometer, parsed.endOdometer,
        parsed.startLocation, parsed.endLocation, parsed.description,
        req.params.id, tenantId,
      ],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: 'trip not found' });
    return { trip: r.rows[0] };
  });

  app.delete<{ Params: { id: string } }>('/api/mileage/:id', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isUuid(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const r = await query(
      'DELETE FROM mileage_log WHERE id = $1 AND tenant_id = $2',
      [req.params.id, tenantId],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: 'trip not found' });
    return reply.code(204).send();
  });

  app.get<{ Params: { year: string } }>(
    '/api/mileage/summary/:year',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const year = Number(req.params.year);
      if (!Number.isInteger(year) || year < 1900 || year > 2200) {
        return reply.code(400).send({ error: 'year must be 1900..2200' });
      }
      const r = await query<{ purpose: string; miles: string; trip_count: string }>(
        `SELECT purpose, SUM(miles)::numeric AS miles, COUNT(*)::int AS trip_count
           FROM mileage_log
          WHERE tenant_id = $1
            AND trip_date BETWEEN $2::date AND $3::date
          GROUP BY purpose`,
        [tenantId, `${year}-01-01`, `${year}-12-31`],
      );
      const rates = mileageRatesForYear(year);
      const byPurpose = r.rows.map((row) => {
        const miles = Number(row.miles);
        const rate = rates[row.purpose as MileagePurpose];
        return {
          purpose: row.purpose as MileagePurpose,
          miles,
          trip_count: Number(row.trip_count),
          rate_cents_per_mile: rate,
          deduction_cents: Math.round(miles * rate),
        };
      });
      const total_miles = byPurpose.reduce((a, b) => a + b.miles, 0);
      const total_deduction_cents = byPurpose.reduce(
        (a, b) => a + b.deduction_cents,
        0,
      );
      return {
        year,
        rates,
        by_purpose: byPurpose,
        total_miles,
        total_deduction_cents,
      };
    },
  );
}
