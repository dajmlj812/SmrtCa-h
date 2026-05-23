import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { isUuid } from '../util.js';

const ROUTE_COLUMNS = `id, name, distance_miles::float8 AS distance_miles,
  toll_per_crossing_cents, active, created_at`;

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function asNonNegativeNumeric(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function asPositiveOrZeroInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

interface AssignmentInput {
  vehicleId: string;
  crossingsPerWeek: number;
}

function parseAssignments(raw: unknown): AssignmentInput[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AssignmentInput[] = [];
  for (const item of raw) {
    const a = item as { vehicleId?: unknown; crossingsPerWeek?: unknown };
    if (typeof a.vehicleId !== 'string' || !isUuid(a.vehicleId)) return null;
    const c = Number(a.crossingsPerWeek);
    if (!Number.isFinite(c) || c < 0) return null;
    out.push({ vehicleId: a.vehicleId, crossingsPerWeek: c });
  }
  return out;
}

/**
 * Commute routes (Phase 7.3). Each route has a distance and an optional
 * per-crossing toll. Assignments link a route to a vehicle with a weekly
 * crossings count; the budget wizard uses (route × assignments) for both
 * fuel and toll math. Vehicles with no assignments fall back to the
 * `vehicles.weekly_avg_miles` field.
 */
export async function commuteRouteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/commute-routes', async () => {
    const routes = await query(
      `SELECT ${ROUTE_COLUMNS} FROM commute_routes
        ORDER BY active DESC, name`,
    );
    const assignments = await query<{
      route_id: string;
      id: string;
      vehicle_id: string;
      crossings_per_week: number;
      vehicle_name: string;
    }>(
      `SELECT a.route_id, a.id, a.vehicle_id,
              a.crossings_per_week::float8 AS crossings_per_week,
              v.name AS vehicle_name
         FROM route_vehicle_assignments a
         JOIN vehicles v ON v.id = a.vehicle_id`,
    );
    const byRoute = new Map<string, typeof assignments.rows>();
    for (const a of assignments.rows) {
      const arr = byRoute.get(a.route_id) ?? [];
      arr.push(a);
      byRoute.set(a.route_id, arr);
    }
    return {
      routes: routes.rows.map((r) => ({
        ...r,
        assignments: byRoute.get((r as { id: string }).id) ?? [],
      })),
    };
  });

  app.post('/api/commute-routes', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asString(body.name);
    if (name === '') return reply.code(400).send({ error: 'name is required' });
    const distance = asNonNegativeNumeric(body.distanceMiles);
    if (distance === null) {
      return reply.code(400).send({ error: 'distanceMiles must be ≥ 0' });
    }
    let toll: number | null = null;
    if (body.tollPerCrossingCents !== undefined && body.tollPerCrossingCents !== null) {
      toll = asPositiveOrZeroInt(body.tollPerCrossingCents);
      if (toll === null) {
        return reply
          .code(400)
          .send({ error: 'tollPerCrossingCents must be ≥ 0 or null' });
      }
    }
    const assignments = parseAssignments(body.assignments ?? []);
    if (assignments === null) {
      return reply
        .code(400)
        .send({ error: 'assignments must be an array of { vehicleId, crossingsPerWeek }' });
    }

    const route = await withTransaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO commute_routes (name, distance_miles, toll_per_crossing_cents)
         VALUES ($1, $2, $3) RETURNING ${ROUTE_COLUMNS}`,
        [name, distance, toll],
      );
      const id = (ins.rows[0] as { id: string }).id;
      for (const a of assignments) {
        await client.query(
          `INSERT INTO route_vehicle_assignments (route_id, vehicle_id, crossings_per_week)
           VALUES ($1, $2, $3)`,
          [id, a.vehicleId, a.crossingsPerWeek],
        );
      }
      return ins.rows[0];
    });

    return reply.code(201).send({ route });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/commute-routes/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name !== undefined) {
        const n = asString(body.name);
        if (n === '') return reply.code(400).send({ error: 'name cannot be empty' });
        params.push(n);
        sets.push(`name = $${params.length}`);
      }
      if (body.distanceMiles !== undefined) {
        const d = asNonNegativeNumeric(body.distanceMiles);
        if (d === null) {
          return reply.code(400).send({ error: 'distanceMiles must be ≥ 0' });
        }
        params.push(d);
        sets.push(`distance_miles = $${params.length}`);
      }
      if (body.tollPerCrossingCents !== undefined) {
        if (body.tollPerCrossingCents === null) {
          params.push(null);
        } else {
          const t = asPositiveOrZeroInt(body.tollPerCrossingCents);
          if (t === null) {
            return reply
              .code(400)
              .send({ error: 'tollPerCrossingCents must be ≥ 0 or null' });
          }
          params.push(t);
        }
        sets.push(`toll_per_crossing_cents = $${params.length}`);
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
        `UPDATE commute_routes SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING ${ROUTE_COLUMNS}`,
        params,
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Route not found' });
      }
      return { route: r.rows[0] };
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/commute-routes/:id/assignments',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const body = (req.body ?? {}) as { assignments?: unknown };
      const assignments = parseAssignments(body.assignments);
      if (assignments === null) {
        return reply
          .code(400)
          .send({ error: 'assignments must be [{ vehicleId, crossingsPerWeek }]' });
      }
      // Verify route exists.
      const route = await pool.query(
        `SELECT id FROM commute_routes WHERE id = $1`,
        [req.params.id],
      );
      if (route.rowCount === 0) {
        return reply.code(404).send({ error: 'Route not found' });
      }
      await withTransaction(async (client) => {
        await client.query(
          `DELETE FROM route_vehicle_assignments WHERE route_id = $1`,
          [req.params.id],
        );
        for (const a of assignments) {
          await client.query(
            `INSERT INTO route_vehicle_assignments (route_id, vehicle_id, crossings_per_week)
             VALUES ($1, $2, $3)`,
            [req.params.id, a.vehicleId, a.crossingsPerWeek],
          );
        }
      });
      return { ok: true, count: assignments.length };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/commute-routes/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const r = await query('DELETE FROM commute_routes WHERE id = $1', [
        req.params.id,
      ]);
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Route not found' });
      }
      return reply.code(204).send();
    },
  );
}
