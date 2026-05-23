import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';

const COLUMNS = `id, name, weekly_estimate_cents, active, created_at`;

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function asNonNegativeInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export async function tollRouteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/toll-routes', async () => {
    const r = await query(
      `SELECT ${COLUMNS} FROM toll_routes ORDER BY active DESC, name`,
    );
    return { tollRoutes: r.rows };
  });

  app.post('/api/toll-routes', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asString(body.name);
    if (name === '') return reply.code(400).send({ error: 'name is required' });
    const weekly = asNonNegativeInt(body.weeklyEstimateCents);
    if (weekly === null) {
      return reply.code(400).send({ error: 'weeklyEstimateCents must be ≥ 0' });
    }
    const r = await query(
      `INSERT INTO toll_routes (name, weekly_estimate_cents)
       VALUES ($1, $2) RETURNING ${COLUMNS}`,
      [name, weekly],
    );
    return reply.code(201).send({ tollRoute: r.rows[0] });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/toll-routes/:id',
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
      if (body.weeklyEstimateCents !== undefined) {
        const w = asNonNegativeInt(body.weeklyEstimateCents);
        if (w === null) {
          return reply.code(400).send({ error: 'weeklyEstimateCents must be ≥ 0' });
        }
        params.push(w);
        sets.push(`weekly_estimate_cents = $${params.length}`);
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
        `UPDATE toll_routes SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING ${COLUMNS}`,
        params,
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Toll route not found' });
      }
      return { tollRoute: r.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/toll-routes/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const r = await query('DELETE FROM toll_routes WHERE id = $1', [req.params.id]);
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Toll route not found' });
      }
      return reply.code(204).send();
    },
  );
}
