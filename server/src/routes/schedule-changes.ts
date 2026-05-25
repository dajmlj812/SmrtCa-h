import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { isUuid } from '../util.js';
import { requireTenant } from '../auth/rbac.js';
import {
  ScheduleChangeError,
  addForBill,
  addForIncome,
  deleteChange,
  listForBill,
  listForIncome,
  promoteDueChanges,
} from '../domain/schedule-changes.js';

/**
 * 0.18.13 — routes for future-effective changes on bills + income.
 *
 *   GET    /api/bills/:id/schedule-changes
 *   POST   /api/bills/:id/schedule-changes
 *   DELETE /api/schedule-changes/:changeId   (works for either kind)
 *
 *   GET    /api/recurring-income/:id/schedule-changes
 *   POST   /api/recurring-income/:id/schedule-changes
 *
 * The DELETE endpoint is target-agnostic (deletes by change id, no
 * matter which kind) — simpler than two separate delete paths.
 *
 * On every list/add request we opportunistically promote any past-
 * due changes for the tenant. That keeps the parent rows accurate
 * without requiring a separate scheduler.
 */
export async function scheduleChangeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/bills/:id/schedule-changes',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid bill id' });
      }
      // Promote anything that's now due before reading — keeps the
      // bill amount in sync.
      await promoteDueChanges(tenantId);
      return { changes: await listForBill(tenantId, req.params.id) };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      effective_date?: unknown;
      new_amount_cents?: unknown;
      new_frequency?: unknown;
      note?: unknown;
    };
  }>('/api/bills/:id/schedule-changes', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isUuid(req.params.id)) {
      return reply.code(400).send({ error: 'Invalid bill id' });
    }
    // Confirm the bill belongs to the tenant before accepting a
    // change row — otherwise an attacker who guessed a UUID could
    // pin schedule changes onto another tenant's bills.
    const ok = await pool.query(
      `SELECT 1 FROM bills WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId],
    );
    if (ok.rowCount === 0) {
      return reply.code(404).send({ error: 'Bill not found' });
    }
    try {
      const body = req.body ?? {};
      const change = await addForBill(
        tenantId,
        req.params.id,
        {
          effective_date: String(body.effective_date ?? ''),
          new_amount_cents:
            body.new_amount_cents === undefined ||
            body.new_amount_cents === null ||
            body.new_amount_cents === ''
              ? null
              : Number(body.new_amount_cents),
          new_frequency:
            typeof body.new_frequency === 'string' && body.new_frequency !== ''
              ? (body.new_frequency as 'monthly' | 'weekly' | 'biweekly' | 'yearly' | 'one-time')
              : null,
          note:
            typeof body.note === 'string' && body.note.trim() !== ''
              ? body.note.trim()
              : null,
        },
        req.user!.id,
      );
      return reply.code(201).send({ change });
    } catch (err) {
      if (err instanceof ScheduleChangeError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>(
    '/api/recurring-income/:id/schedule-changes',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid recurring-income id' });
      }
      await promoteDueChanges(tenantId);
      return { changes: await listForIncome(tenantId, req.params.id) };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      effective_date?: unknown;
      new_amount_cents?: unknown;
      new_frequency?: unknown;
      note?: unknown;
    };
  }>('/api/recurring-income/:id/schedule-changes', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isUuid(req.params.id)) {
      return reply.code(400).send({ error: 'Invalid recurring-income id' });
    }
    const ok = await pool.query(
      `SELECT 1 FROM recurring_income WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId],
    );
    if (ok.rowCount === 0) {
      return reply.code(404).send({ error: 'Recurring income not found' });
    }
    try {
      const body = req.body ?? {};
      const change = await addForIncome(
        tenantId,
        req.params.id,
        {
          effective_date: String(body.effective_date ?? ''),
          new_amount_cents:
            body.new_amount_cents === undefined ||
            body.new_amount_cents === null ||
            body.new_amount_cents === ''
              ? null
              : Number(body.new_amount_cents),
          new_frequency:
            typeof body.new_frequency === 'string' && body.new_frequency !== ''
              ? (body.new_frequency as 'monthly' | 'weekly' | 'biweekly' | 'yearly')
              : null,
          note:
            typeof body.note === 'string' && body.note.trim() !== ''
              ? body.note.trim()
              : null,
        },
        req.user!.id,
      );
      return reply.code(201).send({ change });
    } catch (err) {
      if (err instanceof ScheduleChangeError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/api/schedule-changes/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid change id' });
      }
      const removed = await deleteChange(tenantId, req.params.id);
      if (!removed) {
        return reply
          .code(404)
          .send({ error: 'Change not found or already applied' });
      }
      return reply.code(204).send();
    },
  );
}
