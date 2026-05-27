import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { isUuid } from '../util.js';
import { assertAccountInTenant, requireTenant } from '../auth/rbac.js';

/**
 * 0.21.3 — non-traditional household model.
 *
 * Three resources:
 *   /api/household/participants  — CRUD named people
 *   /api/household/splits        — set per-account percentage splits
 *   /api/household/custody-periods — set date-ranged account ownership
 *
 * Read endpoints under /api/household/* are tenant-scoped. Writes
 * require the same tenant role check as other ops (admin or
 * spouse). Children can't touch household structure.
 */

const PARTICIPANT_KINDS = [
  'spouse', 'child', 'co_parent', 'roommate', 'dependent', 'other',
];

const PARTICIPANT_COLUMNS = `id, name, kind, email, color, active, created_at`;
const SPLIT_COLUMNS = `id, account_id, participant_id, split_pct::float8 AS split_pct, created_at`;
const CUSTODY_COLUMNS = `
  id, account_id, participant_id,
  start_date::text AS start_date,
  end_date::text   AS end_date,
  created_at`;

async function participantInTenant(tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    'SELECT 1 FROM household_participants WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function householdRoutes(app: FastifyInstance): Promise<void> {
  // ── Participants ───────────────────────────────────────────
  app.get('/api/household/participants', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const r = await query(
      `SELECT ${PARTICIPANT_COLUMNS}
         FROM household_participants
        WHERE tenant_id = $1
        ORDER BY active DESC, name`,
      [tenantId],
    );
    return { participants: r.rows };
  });

  app.post('/api/household/participants', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return reply.code(400).send({ error: 'name required' });
    }
    const kind = typeof body.kind === 'string' ? body.kind : 'other';
    if (!PARTICIPANT_KINDS.includes(kind)) {
      return reply.code(400).send({
        error: `kind must be one of ${PARTICIPANT_KINDS.join(', ')}`,
      });
    }
    const email = typeof body.email === 'string' && body.email.trim()
      ? body.email.trim().toLowerCase() : null;
    const color = typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color)
      ? body.color.toLowerCase() : null;
    const r = await query(
      `INSERT INTO household_participants (tenant_id, name, kind, email, color)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PARTICIPANT_COLUMNS}`,
      [tenantId, body.name.trim(), kind, email, color],
    );
    return reply.code(201).send({ participant: r.rows[0] });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/household/participants/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) {
          return reply.code(400).send({ error: 'name cannot be empty' });
        }
        params.push(body.name.trim());
        sets.push(`name = $${params.length}`);
      }
      if (body.kind !== undefined) {
        if (typeof body.kind !== 'string' || !PARTICIPANT_KINDS.includes(body.kind)) {
          return reply.code(400).send({ error: 'invalid kind' });
        }
        params.push(body.kind);
        sets.push(`kind = $${params.length}`);
      }
      if (body.email !== undefined) {
        params.push(
          body.email === null ? null
            : (typeof body.email === 'string' ? body.email.trim().toLowerCase() : null),
        );
        sets.push(`email = $${params.length}`);
      }
      if (body.color !== undefined) {
        params.push(body.color === null ? null : String(body.color));
        sets.push(`color = $${params.length}`);
      }
      if (body.active !== undefined) {
        params.push(Boolean(body.active));
        sets.push(`active = $${params.length}`);
      }
      if (sets.length === 0) {
        return reply.code(400).send({ error: 'no updates' });
      }
      params.push(req.params.id, tenantId);
      const r = await query(
        `UPDATE household_participants SET ${sets.join(', ')}
          WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
          RETURNING ${PARTICIPANT_COLUMNS}`,
        params,
      );
      if (r.rowCount === 0) return reply.code(404).send({ error: 'participant not found' });
      return { participant: r.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/household/participants/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
      const r = await query(
        'DELETE FROM household_participants WHERE id = $1 AND tenant_id = $2',
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0) return reply.code(404).send({ error: 'participant not found' });
      return reply.code(204).send();
    },
  );

  // ── Account splits ─────────────────────────────────────────
  app.get<{ Querystring: { accountId?: string } }>(
    '/api/household/splits',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const params: unknown[] = [tenantId];
      let where = 'tenant_id = $1';
      if (req.query.accountId) {
        if (!isUuid(req.query.accountId)) {
          return reply.code(400).send({ error: 'invalid accountId' });
        }
        params.push(req.query.accountId);
        where += ` AND account_id = $${params.length}`;
      }
      const r = await query(
        `SELECT ${SPLIT_COLUMNS} FROM account_splits WHERE ${where}`,
        params,
      );
      return { splits: r.rows };
    },
  );

  // PUT replaces the entire split set for an account in one shot.
  // Easier semantics than per-row CRUD; the UI also thinks of
  // splits as one editable group per account.
  app.put<{ Params: { accountId: string } }>(
    '/api/household/splits/:accountId',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.accountId)) {
        return reply.code(400).send({ error: 'invalid accountId' });
      }
      if (!(await assertAccountInTenant(tenantId, req.params.accountId))) {
        return reply.code(404).send({ error: 'account not found' });
      }
      const body = (req.body ?? {}) as { splits?: unknown };
      if (!Array.isArray(body.splits)) {
        return reply.code(400).send({ error: 'splits must be an array' });
      }
      const rows: Array<{ participantId: string; splitPct: number }> = [];
      for (const item of body.splits) {
        const s = item as { participantId?: unknown; splitPct?: unknown };
        if (typeof s.participantId !== 'string' || !isUuid(s.participantId)) {
          return reply.code(400).send({ error: 'each split needs a UUID participantId' });
        }
        const pct = Number(s.splitPct);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
          return reply.code(400).send({ error: 'splitPct must be in (0, 100]' });
        }
        rows.push({ participantId: s.participantId, splitPct: pct });
      }
      if (rows.length > 0) {
        const sum = rows.reduce((a, b) => a + b.splitPct, 0);
        if (Math.abs(sum - 100) > 0.001) {
          return reply
            .code(400)
            .send({ error: `split percentages must sum to 100 (got ${sum.toFixed(3)})` });
        }
        // Validate every participant belongs to this tenant.
        const ids = rows.map((r) => r.participantId);
        const ok = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM household_participants
            WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
          [tenantId, ids],
        );
        if (Number(ok.rows[0]!.count) !== new Set(ids).size) {
          return reply.code(400).send({ error: 'one or more participantIds not in tenant' });
        }
      }
      const result = await withTransaction(async (client) => {
        await client.query(
          'DELETE FROM account_splits WHERE account_id = $1',
          [req.params.accountId],
        );
        for (const r of rows) {
          await client.query(
            `INSERT INTO account_splits (tenant_id, account_id, participant_id, split_pct)
             VALUES ($1, $2, $3, $4)`,
            [tenantId, req.params.accountId, r.participantId, r.splitPct],
          );
        }
        const r = await client.query(
          `SELECT ${SPLIT_COLUMNS} FROM account_splits
            WHERE account_id = $1`,
          [req.params.accountId],
        );
        return r.rows;
      });
      return { splits: result };
    },
  );

  // ── Custody periods ────────────────────────────────────────
  app.get<{ Querystring: { accountId?: string } }>(
    '/api/household/custody-periods',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const params: unknown[] = [tenantId];
      let where = 'tenant_id = $1';
      if (req.query.accountId) {
        if (!isUuid(req.query.accountId)) {
          return reply.code(400).send({ error: 'invalid accountId' });
        }
        params.push(req.query.accountId);
        where += ` AND account_id = $${params.length}`;
      }
      const r = await query(
        `SELECT ${CUSTODY_COLUMNS} FROM custody_periods
          WHERE ${where}
          ORDER BY start_date DESC`,
        params,
      );
      return { custodyPeriods: r.rows };
    },
  );

  app.post('/api/household/custody-periods', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.accountId !== 'string' || !isUuid(body.accountId)) {
      return reply.code(400).send({ error: 'accountId required' });
    }
    if (typeof body.participantId !== 'string' || !isUuid(body.participantId)) {
      return reply.code(400).send({ error: 'participantId required' });
    }
    if (typeof body.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
      return reply.code(400).send({ error: 'startDate must be YYYY-MM-DD' });
    }
    let endDate: string | null = null;
    if (body.endDate !== undefined && body.endDate !== null) {
      if (typeof body.endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate)) {
        return reply.code(400).send({ error: 'endDate must be YYYY-MM-DD or null' });
      }
      if (body.endDate < body.startDate) {
        return reply.code(400).send({ error: 'endDate must be >= startDate' });
      }
      endDate = body.endDate;
    }
    if (!(await assertAccountInTenant(tenantId, body.accountId))) {
      return reply.code(400).send({ error: 'accountId not found' });
    }
    if (!(await participantInTenant(tenantId, body.participantId))) {
      return reply.code(400).send({ error: 'participantId not found' });
    }
    const r = await query(
      `INSERT INTO custody_periods (tenant_id, account_id, participant_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${CUSTODY_COLUMNS}`,
      [tenantId, body.accountId, body.participantId, body.startDate, endDate],
    );
    return reply.code(201).send({ custodyPeriod: r.rows[0] });
  });

  app.delete<{ Params: { id: string } }>(
    '/api/household/custody-periods/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
      const r = await query(
        'DELETE FROM custody_periods WHERE id = $1 AND tenant_id = $2',
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'custody period not found' });
      }
      return reply.code(204).send();
    },
  );

  // ── Per-participant rollup ─────────────────────────────────
  // Splits each transaction across participants via account_splits;
  // custody_periods override (if a txn_date falls inside a period
  // it's 100% attributed to that participant). Used for per-person
  // year-to-date and report drilldowns.
  app.get<{ Querystring: { startDate?: string; endDate?: string } }>(
    '/api/household/participants/totals',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const startDate = req.query.startDate || `${new Date().getUTCFullYear()}-01-01`;
      const endDate = req.query.endDate || `${new Date().getUTCFullYear()}-12-31`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return reply.code(400).send({ error: 'dates must be YYYY-MM-DD' });
      }
      const r = await pool.query<{
        participant_id: string;
        participant_name: string;
        spend_cents: string;
        income_cents: string;
      }>(
        `WITH covered AS (
           SELECT t.id AS txn_id, t.amount_cents, t.txn_date,
                  COALESCE(
                    -- Custody-period override: if a period covers
                    -- this txn_date, attribute 100% to that
                    -- participant. Latest-start wins among overlaps.
                    (SELECT p.participant_id
                       FROM custody_periods p
                      WHERE p.account_id = t.account_id
                        AND p.tenant_id = $1
                        AND p.start_date <= t.txn_date
                        AND (p.end_date IS NULL OR p.end_date >= t.txn_date)
                      ORDER BY p.start_date DESC
                      LIMIT 1),
                    NULL
                  ) AS custody_pid,
                  t.account_id
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
            WHERE a.tenant_id = $1
              AND t.txn_date BETWEEN $2::date AND $3::date
              AND t.transfer_group_id IS NULL
         ),
         attributed AS (
           SELECT c.txn_id, c.amount_cents, p.id AS participant_id,
                  hp.name AS participant_name,
                  CASE
                    WHEN c.custody_pid IS NOT NULL THEN 1.0
                    ELSE s.split_pct / 100.0
                  END AS share
             FROM covered c
             LEFT JOIN account_splits s
                    ON s.account_id = c.account_id
                   AND s.tenant_id = $1
             JOIN household_participants p
               ON p.id = COALESCE(c.custody_pid, s.participant_id)
              AND p.tenant_id = $1
             JOIN household_participants hp ON hp.id = p.id
            WHERE (c.custody_pid IS NOT NULL OR s.id IS NOT NULL)
              -- When there's a custody match, drop the unrelated
              -- split rows so we don't double-count.
              AND (c.custody_pid IS NULL OR p.id = c.custody_pid)
         )
         SELECT participant_id, participant_name,
                SUM(GREATEST(0, -amount_cents) * share)::bigint::text AS spend_cents,
                SUM(GREATEST(0, amount_cents) * share)::bigint::text  AS income_cents
           FROM attributed
          GROUP BY participant_id, participant_name
          ORDER BY participant_name`,
        [tenantId, startDate, endDate],
      );
      return {
        startDate, endDate,
        totals: r.rows.map((row) => ({
          participant_id: row.participant_id,
          participant_name: row.participant_name,
          spend_cents: Number(row.spend_cents),
          income_cents: Number(row.income_cents),
        })),
      };
    },
  );
}
