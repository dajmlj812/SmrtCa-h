import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { requireTenant } from '../auth/rbac.js';
import { advanceByFrequency } from './bills.js';
import {
  resolveTriage,
  sweepOverdueBills,
  tryMatchTransaction,
} from '../domain/bill-matcher.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 0.22.0 — Routes that drive the bill matching engine: triage queue,
 * skip/pause/unpause, manual overdue sweep, and rescan-unmatched.
 */
export async function billMatchingRoutes(app: FastifyInstance): Promise<void> {
  // ── Triage queue ─────────────────────────────────────────
  app.get('/api/bills/triage', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const r = await query(
      `SELECT tri.id, tri.bill_id, tri.transaction_id, tri.reason,
              tri.amount_fit, tri.date_fit, tri.created_at,
              b.name AS bill_name,
              b.amount_cents AS bill_amount_cents,
              b.next_due_date AS bill_next_due_date,
              b.amount_mode AS bill_amount_mode,
              t.txn_date,
              t.amount_cents AS txn_amount_cents,
              t.raw_description,
              t.normalized_merchant
         FROM bill_match_triage tri
         JOIN bills b ON b.id = tri.bill_id
         JOIN transactions t ON t.id = tri.transaction_id
        WHERE tri.tenant_id = $1
          AND tri.resolved_at IS NULL
        ORDER BY tri.created_at DESC`,
      [tenantId],
    );
    return { triage: r.rows };
  });

  app.post<{ Params: { id: string }; Body: { resolution?: string } }>(
    '/api/bills/triage/:id/resolve',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const resolution = req.body?.resolution;
      if (
        resolution !== 'accepted' &&
        resolution !== 'rejected' &&
        resolution !== 'reassigned'
      ) {
        return reply
          .code(400)
          .send({ error: 'resolution must be accepted|rejected|reassigned' });
      }
      // Tenant ownership check: ensure the triage row belongs to caller.
      const owns = await query(
        `SELECT 1 FROM bill_match_triage WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (owns.rows.length === 0) {
        return reply.code(404).send({ error: 'not found' });
      }
      const out = await resolveTriage(req.params.id, resolution);
      return { resolved: true, matched_bill_id: out.matched_bill_id };
    },
  );

  // ── Skip / pause / unpause ──────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/bills/:id/skip-period',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const bill = await query<{
        next_due_date: string;
        frequency: string;
      }>(
        `SELECT next_due_date, frequency FROM bills
          WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (bill.rows.length === 0) {
        return reply.code(404).send({ error: 'not found' });
      }
      const { next_due_date, frequency } = bill.rows[0]!;
      await query(
        `INSERT INTO bill_periods
           (bill_id, period_anchor_date, tenant_id, status, skipped_at)
         VALUES ($1, $2, $3, 'skipped', now())
         ON CONFLICT (bill_id, period_anchor_date) DO UPDATE
           SET status = 'skipped',
               skipped_at = now(),
               updated_at = now()`,
        [req.params.id, next_due_date, tenantId],
      );
      const next = advanceByFrequency(
        next_due_date,
        frequency as Parameters<typeof advanceByFrequency>[1],
      );
      if (next) {
        await query(`UPDATE bills SET next_due_date = $1 WHERE id = $2`, [
          next,
          req.params.id,
        ]);
      }
      return { skipped: true, advanced_to: next };
    },
  );

  app.post<{ Params: { id: string }; Body: { until?: string } }>(
    '/api/bills/:id/pause',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const until = req.body?.until;
      if (!until || !YMD.test(until)) {
        return reply
          .code(400)
          .send({ error: 'until must be YYYY-MM-DD' });
      }
      const r = await query(
        `UPDATE bills SET paused_until = $1
          WHERE id = $2 AND tenant_id = $3
          RETURNING id`,
        [until, req.params.id, tenantId],
      );
      if (r.rows.length === 0) {
        return reply.code(404).send({ error: 'not found' });
      }
      return { paused_until: until };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/bills/:id/unpause',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const r = await query(
        `UPDATE bills SET paused_until = NULL
          WHERE id = $1 AND tenant_id = $2
          RETURNING id`,
        [req.params.id, tenantId],
      );
      if (r.rows.length === 0) {
        return reply.code(404).send({ error: 'not found' });
      }
      return { paused_until: null };
    },
  );

  // ── Manual sweeps (for testing + on-demand triggering) ──
  app.post('/api/bills/sweep-overdue', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const today = new Date().toISOString().slice(0, 10);
    const out = await sweepOverdueBills(today);
    return out;
  });

  /**
   * Rescan ALL unmatched transactions for this tenant against the
   * bill set. Useful after editing merchant_pattern / amount_mode on
   * bills, or on initial 0.22.0 rollout, to catch retro matches.
   * Bounded to the last 90 days to keep the work tractable.
   */
  app.post('/api/bills/rescan', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const r = await query<{ id: string }>(
      `SELECT t.id
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.tenant_id = $1
          AND t.amount_cents < 0
          AND t.txn_date >= (CURRENT_DATE - INTERVAL '90 days')
          AND NOT EXISTS (
            SELECT 1 FROM bill_periods bp WHERE bp.matched_txn_id = t.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM bill_match_triage tri
             WHERE tri.transaction_id = t.id AND tri.resolved_at IS NULL
          )
        ORDER BY t.txn_date DESC`,
      [tenantId],
    );
    let matched = 0;
    let triaged = 0;
    for (const row of r.rows) {
      const out = await tryMatchTransaction(row.id);
      if (out.matched_bill_id) matched += 1;
      triaged += out.triaged;
    }
    return { scanned: r.rows.length, matched, triaged };
  });

  // ── Per-bill period history (for the /recurring detail panel) ──
  app.get<{ Params: { id: string } }>(
    '/api/bills/:id/periods',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const owns = await query(
        `SELECT 1 FROM bills WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (owns.rows.length === 0) {
        return reply.code(404).send({ error: 'not found' });
      }
      const r = await query(
        `SELECT bp.period_anchor_date, bp.status, bp.matched_txn_id,
                bp.marked_paid_at, bp.skipped_at,
                t.txn_date, t.amount_cents, t.raw_description
           FROM bill_periods bp
           LEFT JOIN transactions t ON t.id = bp.matched_txn_id
          WHERE bp.bill_id = $1
          ORDER BY bp.period_anchor_date DESC
          LIMIT 24`,
        [req.params.id],
      );
      return { periods: r.rows };
    },
  );
}
