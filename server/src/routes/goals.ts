import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { assertAccountInTenant, requireTenant } from '../auth/rbac.js';

interface GoalBody {
  name?: unknown;
  targetAmountCents?: unknown;
  currentAmountCents?: unknown;
  targetDate?: unknown;
  accountId?: unknown;
  // 0.22.2 — payoff-goal inputs.
  kind?: unknown;
  initialAmountCents?: unknown;
  linkedAccountIds?: unknown;
  targetUtilizationPct?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNonNegativeInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function isYmdOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * 0.22.2 — GOAL_COLUMNS expanded for payoff goals.
 *
 * For payoff goals: progress shrinks the balance toward the target,
 * so display math is (initial - current) / (initial - target).
 * computed_balance_cents is the live SUM of |balance| across
 * linked accounts; the UI prefers that over current_amount_cents
 * for payoff goals so progress reflects new statements
 * immediately. For savings goals, those new fields are NULL and
 * progress keeps the original current / target formula.
 *
 * Live balance computation uses the same opening_balance +
 * trailing-txn sum as /api/accounts. For credit cards / loans /
 * manual liabilities, balances are stored signed-negative under
 * the 0.20.x liability-sign convention, so ABS() makes the math
 * always work in positive "amount owed" cents.
 */
const GOAL_COLUMNS = `id, name, target_amount_cents, current_amount_cents,
  target_date, account_id, created_at,
  kind, initial_amount_cents, linked_account_ids, target_utilization_pct,
  CASE
    WHEN kind = 'payoff'
      THEN COALESCE((
        SELECT SUM(ABS(
          a.opening_balance_cents + COALESCE((
            SELECT SUM(t.amount_cents) FROM transactions t
             WHERE t.account_id = a.id
               AND t.txn_date >= a.opening_balance_date
          ), 0)
        ))::bigint
          FROM accounts a
         WHERE a.id = ANY(linked_account_ids)
           AND a.tenant_id = savings_goals.tenant_id
      ), 0)
    ELSE NULL
  END AS computed_balance_cents,
  CASE
    WHEN kind = 'payoff' THEN
      CASE
        WHEN initial_amount_cents IS NULL
          OR initial_amount_cents <= target_amount_cents THEN 0
        ELSE LEAST(1.0,
          GREATEST(0,
            (initial_amount_cents::numeric -
              COALESCE((
                SELECT SUM(ABS(
                  a.opening_balance_cents + COALESCE((
                    SELECT SUM(t.amount_cents) FROM transactions t
                     WHERE t.account_id = a.id
                       AND t.txn_date >= a.opening_balance_date
                  ), 0)
                ))::bigint
                  FROM accounts a
                 WHERE a.id = ANY(linked_account_ids)
                   AND a.tenant_id = savings_goals.tenant_id
              ), 0)
            )::numeric
              / NULLIF(initial_amount_cents - target_amount_cents, 0)
          )
        )
      END
    WHEN target_amount_cents = 0 THEN 0
    ELSE LEAST(1.0, current_amount_cents::numeric / target_amount_cents)
  END AS progress`;

/**
 * 0.14.1 — savings goals are tenant-scoped (audit missed this file
 * but it had the same unscoped pattern as bills/budgets). GET filters
 * by tenant; POST writes tenant_id from session; PATCH/DELETE WHERE
 * by id AND tenant_id so cross-tenant ids 404 identically.
 */
export async function goalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/goals', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const r = await query(
      `SELECT ${GOAL_COLUMNS}
         FROM savings_goals
        WHERE tenant_id = $1
        ORDER BY (target_date IS NULL),  -- dated goals first
                 target_date ASC,
                 created_at`,
      [tenantId],
    );
    return { goals: r.rows };
  });

  app.post('/api/goals', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as GoalBody;
    const name = asString(body.name);
    if (name === '') {
      return reply.code(400).send({ error: 'Name is required' });
    }
    // 0.22.2 — kind discriminator. Default 'savings' preserves the
    // existing API for callers that don't know about payoff.
    const kind = body.kind === 'payoff' ? 'payoff' : 'savings';

    // For savings goals: target must be > 0. For payoff goals:
    // target is the *target balance to reach* (e.g. $0 to pay off,
    // or some positive number representing the 30%-utilization
    // dollar threshold). 0 is valid (full payoff).
    const target =
      kind === 'payoff'
        ? asNonNegativeInt(body.targetAmountCents)
        : asPositiveInt(body.targetAmountCents);
    if (target === null) {
      return reply.code(400).send({
        error:
          kind === 'payoff'
            ? 'targetAmountCents must be a non-negative integer (target balance)'
            : 'targetAmountCents must be a positive integer',
      });
    }
    let current = 0;
    if (body.currentAmountCents !== undefined) {
      const c = asNonNegativeInt(body.currentAmountCents);
      if (c === null) {
        return reply
          .code(400)
          .send({ error: 'currentAmountCents must be ≥ 0' });
      }
      current = c;
    }
    if (body.targetDate !== undefined && !isYmdOrNull(body.targetDate)) {
      return reply
        .code(400)
        .send({ error: 'targetDate must be YYYY-MM-DD or null' });
    }
    let accountId: string | null = null;
    if (typeof body.accountId === 'string' && isUuid(body.accountId)) {
      const ok = await assertAccountInTenant(tenantId, body.accountId);
      if (!ok) return reply.code(400).send({ error: 'Invalid accountId' });
      accountId = body.accountId;
    }

    // 0.22.2 — payoff-specific fields.
    let initialAmountCents: number | null = null;
    let linkedAccountIds: string[] | null = null;
    let targetUtilizationPct: number | null = null;
    if (kind === 'payoff') {
      const init = asNonNegativeInt(body.initialAmountCents);
      if (init === null || init <= target) {
        return reply.code(400).send({
          error:
            'Payoff goals require initialAmountCents > targetAmountCents (otherwise there is nothing to pay down)',
        });
      }
      initialAmountCents = init;

      if (!Array.isArray(body.linkedAccountIds) || body.linkedAccountIds.length === 0) {
        return reply.code(400).send({
          error: 'Payoff goals require at least one linked account',
        });
      }
      const accounts: string[] = [];
      for (const raw of body.linkedAccountIds) {
        if (typeof raw !== 'string' || !isUuid(raw)) {
          return reply
            .code(400)
            .send({ error: 'linkedAccountIds must be uuids' });
        }
        const ok = await assertAccountInTenant(tenantId, raw);
        if (!ok) {
          return reply.code(400).send({ error: 'Invalid linkedAccountIds' });
        }
        accounts.push(raw);
      }
      linkedAccountIds = accounts;

      if (
        body.targetUtilizationPct !== undefined &&
        body.targetUtilizationPct !== null
      ) {
        const p = Number(body.targetUtilizationPct);
        if (!Number.isFinite(p) || p < 0 || p > 100) {
          return reply
            .code(400)
            .send({ error: 'targetUtilizationPct must be between 0 and 100' });
        }
        targetUtilizationPct = p;
      }
    }

    const r = await query(
      `INSERT INTO savings_goals
         (tenant_id, name, target_amount_cents, current_amount_cents,
          target_date, account_id, kind, initial_amount_cents,
          linked_account_ids, target_utilization_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${GOAL_COLUMNS}`,
      [
        tenantId,
        name,
        target,
        current,
        (body.targetDate as string | null) ?? null,
        accountId,
        kind,
        initialAmountCents,
        linkedAccountIds,
        targetUtilizationPct,
      ],
    );
    return reply.code(201).send({ goal: r.rows[0] });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/goals/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid goal id' });
      }
      const body = (req.body ?? {}) as GoalBody;
      const updates: string[] = [];
      const params: unknown[] = [];

      if (body.name !== undefined) {
        const n = asString(body.name);
        if (n === '') {
          return reply.code(400).send({ error: 'Name cannot be empty' });
        }
        params.push(n);
        updates.push(`name = $${params.length}`);
      }
      if (body.targetAmountCents !== undefined) {
        // 0.22.2 — non-negative (was strictly positive) so payoff
        // goals targeting $0 can be saved.
        const t = asNonNegativeInt(body.targetAmountCents);
        if (t === null) {
          return reply
            .code(400)
            .send({ error: 'targetAmountCents must be ≥ 0' });
        }
        params.push(t);
        updates.push(`target_amount_cents = $${params.length}`);
      }
      if (body.currentAmountCents !== undefined) {
        const c = asNonNegativeInt(body.currentAmountCents);
        if (c === null) {
          return reply
            .code(400)
            .send({ error: 'currentAmountCents must be ≥ 0' });
        }
        params.push(c);
        updates.push(`current_amount_cents = $${params.length}`);
      }
      if (body.targetDate !== undefined) {
        if (!isYmdOrNull(body.targetDate)) {
          return reply
            .code(400)
            .send({ error: 'targetDate must be YYYY-MM-DD or null' });
        }
        params.push(body.targetDate);
        updates.push(`target_date = $${params.length}`);
      }
      // 0.17.21 — accountId editable; null clears.
      if (body.accountId !== undefined) {
        if (body.accountId === null) {
          params.push(null);
          updates.push(`account_id = $${params.length}`);
        } else {
          if (typeof body.accountId !== 'string' || !isUuid(body.accountId)) {
            return reply.code(400).send({ error: 'Invalid accountId' });
          }
          const ok = await assertAccountInTenant(tenantId, body.accountId);
          if (!ok) return reply.code(400).send({ error: 'Invalid accountId' });
          params.push(body.accountId);
          updates.push(`account_id = $${params.length}`);
        }
      }
      if (updates.length === 0) {
        return reply
          .code(400)
          .send({ error: 'No updatable fields provided' });
      }

      params.push(req.params.id);
      const idIdx = params.length;
      params.push(tenantId);
      const tenantIdx = params.length;
      const r = await query(
        `UPDATE savings_goals SET ${updates.join(', ')}
          WHERE id = $${idIdx} AND tenant_id = $${tenantIdx}
       RETURNING ${GOAL_COLUMNS}`,
        params,
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Goal not found' });
      }
      return { goal: r.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/goals/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid goal id' });
      }
      const r = await query(
        `DELETE FROM savings_goals WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Goal not found' });
      }
      return reply.code(204).send();
    },
  );

  // 0.18.5 — record a manual contribution. Atomically inserts a
  // goal_contributions row and bumps savings_goals.current_amount_cents
  // by the same amount. amountCents is signed (negative allowed for
  // withdrawals / corrections). The goal's current is capped at 0
  // server-side; over-target is allowed (some users save past the
  // number).
  app.post<{
    Params: { id: string };
    Body: { amountCents?: unknown; note?: unknown };
  }>('/api/goals/:id/contribute', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isUuid(req.params.id)) {
      return reply.code(400).send({ error: 'Invalid goal id' });
    }
    const amount =
      typeof req.body?.amountCents === 'number'
        ? req.body.amountCents
        : Number(req.body?.amountCents);
    if (!Number.isInteger(amount) || amount === 0) {
      return reply
        .code(400)
        .send({ error: 'amountCents must be a non-zero integer' });
    }
    const note =
      typeof req.body?.note === 'string' && req.body.note.trim() !== ''
        ? req.body.note.trim().slice(0, 500)
        : null;
    const goal = await query<{ id: string; current_amount_cents: string }>(
      `SELECT id, current_amount_cents FROM savings_goals
        WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId],
    );
    if (goal.rowCount === 0) {
      return reply.code(404).send({ error: 'Goal not found' });
    }
    const newCurrent = Math.max(
      0,
      Number(goal.rows[0]!.current_amount_cents) + amount,
    );
    await query(
      `INSERT INTO goal_contributions
         (tenant_id, goal_id, amount_cents, note)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, req.params.id, amount, note],
    );
    const updated = await query(
      `UPDATE savings_goals SET current_amount_cents = $1
        WHERE id = $2 AND tenant_id = $3
       RETURNING ${GOAL_COLUMNS}`,
      [newCurrent, req.params.id, tenantId],
    );
    return { goal: updated.rows[0] };
  });

  app.get<{ Params: { id: string } }>(
    '/api/goals/:id/contributions',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid goal id' });
      }
      const r = await query(
        `SELECT id, amount_cents, note, contributed_at, transaction_id
           FROM goal_contributions
          WHERE goal_id = $1 AND tenant_id = $2
          ORDER BY contributed_at DESC
          LIMIT 50`,
        [req.params.id, tenantId],
      );
      return { contributions: r.rows };
    },
  );
}
