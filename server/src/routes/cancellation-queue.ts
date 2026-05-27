import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { requireTenant } from '../auth/rbac.js';

/**
 * 0.21.6 — manual cancellation queue (scoped down per the legal
 * review). The user adds subscriptions they want to drop, walks
 * through each vendor's own cancel flow themselves, and updates
 * the row's status as they go. We never store vendor credentials
 * and never make outbound requests on the user's behalf.
 */

const QUEUE_COLUMNS = `
  id, bill_id, service_name, status, cancel_url, notes, monthly_cents,
  added_at, last_attempt_at, completed_at`;

const STATUSES = ['queued', 'in_progress', 'done', 'couldnt', 'abandoned'];

interface Input {
  serviceName: string;
  billId: string | null;
  cancelUrl: string | null;
  notes: string | null;
  monthlyCents: number | null;
  status?: string;
}

function parse(body: unknown): Input | string {
  if (!body || typeof body !== 'object') return 'body required';
  const b = body as Record<string, unknown>;
  if (typeof b.serviceName !== 'string' || !b.serviceName.trim()) {
    return 'serviceName required';
  }
  let billId: string | null = null;
  if (b.billId !== undefined && b.billId !== null) {
    if (typeof b.billId !== 'string' || !isUuid(b.billId)) {
      return 'billId must be a UUID or null';
    }
    billId = b.billId;
  }
  let cents: number | null = null;
  if (b.monthlyCents !== undefined && b.monthlyCents !== null) {
    const n = Number(b.monthlyCents);
    if (!Number.isInteger(n) || n < 0) return 'monthlyCents must be a non-negative integer';
    cents = n;
  }
  const status =
    typeof b.status === 'string' && STATUSES.includes(b.status)
      ? b.status
      : 'queued';
  return {
    serviceName: b.serviceName.trim(),
    billId,
    cancelUrl: typeof b.cancelUrl === 'string' && b.cancelUrl.trim() ? b.cancelUrl.trim() : null,
    notes: typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null,
    monthlyCents: cents,
    status,
  };
}

async function billInTenant(tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    'SELECT 1 FROM bills WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function cancellationQueueRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string } }>(
    '/api/cancellation-queue',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const params: unknown[] = [tenantId];
      let where = 'tenant_id = $1';
      if (req.query.status === 'open') {
        where += ` AND status IN ('queued', 'in_progress')`;
      } else if (req.query.status === 'closed') {
        where += ` AND status IN ('done', 'couldnt', 'abandoned')`;
      } else if (req.query.status && STATUSES.includes(req.query.status)) {
        params.push(req.query.status);
        where += ` AND status = $${params.length}`;
      }
      const r = await query(
        `SELECT ${QUEUE_COLUMNS} FROM cancellation_queue
          WHERE ${where} ORDER BY added_at DESC`,
        params,
      );
      return { items: r.rows };
    },
  );

  app.post('/api/cancellation-queue', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const parsed = parse(req.body);
    if (typeof parsed === 'string') return reply.code(400).send({ error: parsed });
    if (parsed.billId && !(await billInTenant(tenantId, parsed.billId))) {
      return reply.code(400).send({ error: 'billId not found' });
    }
    const r = await query(
      `INSERT INTO cancellation_queue
         (tenant_id, bill_id, service_name, status, cancel_url, notes, monthly_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${QUEUE_COLUMNS}`,
      [
        tenantId, parsed.billId, parsed.serviceName, parsed.status ?? 'queued',
        parsed.cancelUrl, parsed.notes, parsed.monthlyCents,
      ],
    );
    return reply.code(201).send({ item: r.rows[0] });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/cancellation-queue/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.serviceName !== undefined) {
        if (typeof body.serviceName !== 'string' || !body.serviceName.trim()) {
          return reply.code(400).send({ error: 'serviceName cannot be empty' });
        }
        params.push(body.serviceName.trim());
        sets.push(`service_name = $${params.length}`);
      }
      if (body.status !== undefined) {
        if (typeof body.status !== 'string' || !STATUSES.includes(body.status)) {
          return reply.code(400).send({ error: `status must be one of ${STATUSES.join(', ')}` });
        }
        params.push(body.status);
        sets.push(`status = $${params.length}`);
        if (body.status === 'in_progress') {
          sets.push('last_attempt_at = now()');
        }
        if (body.status === 'done') {
          sets.push('completed_at = now()');
        }
      }
      if (body.cancelUrl !== undefined) {
        params.push(typeof body.cancelUrl === 'string' && body.cancelUrl.trim()
          ? body.cancelUrl.trim() : null);
        sets.push(`cancel_url = $${params.length}`);
      }
      if (body.notes !== undefined) {
        params.push(typeof body.notes === 'string' && body.notes.trim()
          ? body.notes.trim() : null);
        sets.push(`notes = $${params.length}`);
      }
      if (body.monthlyCents !== undefined) {
        if (body.monthlyCents === null) {
          params.push(null);
        } else {
          const n = Number(body.monthlyCents);
          if (!Number.isInteger(n) || n < 0) {
            return reply.code(400).send({ error: 'monthlyCents must be a non-negative integer' });
          }
          params.push(n);
        }
        sets.push(`monthly_cents = $${params.length}`);
      }
      if (body.billId !== undefined) {
        if (body.billId === null) {
          params.push(null);
        } else if (typeof body.billId === 'string' && isUuid(body.billId)) {
          if (!(await billInTenant(tenantId, body.billId))) {
            return reply.code(400).send({ error: 'billId not found' });
          }
          params.push(body.billId);
        } else {
          return reply.code(400).send({ error: 'invalid billId' });
        }
        sets.push(`bill_id = $${params.length}`);
      }
      if (sets.length === 0) {
        return reply.code(400).send({ error: 'no updates' });
      }
      params.push(req.params.id, tenantId);
      const r = await query(
        `UPDATE cancellation_queue SET ${sets.join(', ')}
          WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
          RETURNING ${QUEUE_COLUMNS}`,
        params,
      );
      if (r.rowCount === 0) return reply.code(404).send({ error: 'queue item not found' });
      return { item: r.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/cancellation-queue/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
      const r = await query(
        'DELETE FROM cancellation_queue WHERE id = $1 AND tenant_id = $2',
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0) return reply.code(404).send({ error: 'queue item not found' });
      return reply.code(204).send();
    },
  );
}
