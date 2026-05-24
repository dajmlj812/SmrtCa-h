import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool, withTransaction } from '../db/pool.js';
import {
  canMutateFinancials,
  loadUserContext,
  requireFinancialMutation,
} from '../auth/rbac.js';
import { recordAudit } from '../domain/audit.js';
import { isUuid } from '../util.js';
import { FEATURES, requireFeature } from '../auth/entitlements.js';

/**
 * Phase 9.2 — bill-splitting routes.
 *
 *   /api/split-participants            CRUD (tenant-scoped)
 *   /api/transactions/:id/shares       GET + PUT (replace all shares)
 *   /api/transaction-shares/:id/settle POST (toggle settled)
 *   /api/shares/summary                GET — net owed per participant
 *   /api/shares                        GET — list unsettled shares
 *
 * Sign convention: share_cents > 0 means the participant owes the
 * tenant; share_cents < 0 means the tenant owes the participant.
 * The tenant's own residual share is NOT stored — it's implied as
 * (transaction.amount_cents - sum(shares.share_cents)).
 */

interface ParticipantBody {
  name?: string;
  email?: string | null;
  userId?: string | null;
  archived?: boolean;
}

function requireTenant(req: FastifyRequest, reply: FastifyReply): string | null {
  if (!req.user) {
    reply.code(401).send({ error: 'Not authenticated' });
    return null;
  }
  if (!req.user.tenantId) {
    reply.code(403).send({ error: 'No active tenant' });
    return null;
  }
  return req.user.tenantId;
}

export async function shareRoutes(app: FastifyInstance): Promise<void> {
  // ── Participants CRUD ────────────────────────────────────
  app.get<{ Querystring: { includeArchived?: string } }>(
    '/api/split-participants',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.BILL_SPLITTING);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const include = req.query.includeArchived === '1';
      const r = await pool.query(
        `SELECT id, name, email, user_id, archived,
                created_at::text, updated_at::text
           FROM split_participants
          WHERE tenant_id = $1
            ${include ? '' : 'AND archived = false'}
          ORDER BY name`,
        [tenantId],
      );
      return { participants: r.rows };
    },
  );

  app.post<{ Body: ParticipantBody }>(
    '/api/split-participants',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.BILL_SPLITTING);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      if (!canMutateFinancials(ctx)) {
        return reply.code(403).send({ error: 'Children cannot manage participants' });
      }
      const name = (req.body?.name ?? '').trim();
      if (!name) return reply.code(400).send({ error: 'name is required' });
      try {
        const r = await pool.query(
          `INSERT INTO split_participants (tenant_id, name, email, user_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, email, user_id, archived, created_at::text`,
          [
            tenantId,
            name,
            req.body?.email?.toString().trim() || null,
            isUuid(req.body?.userId ?? '') ? req.body!.userId : null,
          ],
        );
        return reply.code(201).send({ participant: r.rows[0] });
      } catch (err) {
        if (
          err instanceof Error &&
          /duplicate key/.test(err.message)
        ) {
          return reply.code(409).send({ error: `Participant "${name}" already exists` });
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: ParticipantBody }>(
    '/api/split-participants/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.BILL_SPLITTING);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      if (!canMutateFinancials(ctx)) {
        return reply.code(403).send({ error: 'Children cannot manage participants' });
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      if (typeof req.body?.name === 'string') {
        params.push(req.body.name.trim());
        sets.push(`name = $${params.length}`);
      }
      if (req.body?.email !== undefined) {
        params.push(req.body.email ? String(req.body.email).trim() : null);
        sets.push(`email = $${params.length}`);
      }
      if (req.body?.archived !== undefined) {
        params.push(Boolean(req.body.archived));
        sets.push(`archived = $${params.length}`);
      }
      if (sets.length === 0)
        return reply.code(400).send({ error: 'No updatable fields' });
      sets.push(`updated_at = now()`);
      params.push(req.params.id, tenantId);
      const r = await pool.query(
        `UPDATE split_participants SET ${sets.join(', ')}
          WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
        RETURNING id, name, email, user_id, archived`,
        params,
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Participant not found' });
      return { participant: r.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/split-participants/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.BILL_SPLITTING);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      if (!canMutateFinancials(ctx)) {
        return reply.code(403).send({ error: 'Children cannot manage participants' });
      }
      const r = await pool.query(
        `DELETE FROM split_participants WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Participant not found' });
      return reply.code(204).send();
    },
  );

  // ── Transaction shares ────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/transactions/:id/shares',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.BILL_SPLITTING);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });

      // Verify the txn belongs to this tenant and look up its amount.
      const txn = await pool.query<{ amount_cents: number }>(
        `SELECT t.amount_cents
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE t.id = $1 AND a.tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (txn.rowCount === 0)
        return reply.code(404).send({ error: 'Transaction not found' });

      const shares = await pool.query(
        `SELECT s.id, s.participant_id, p.name AS participant_name,
                s.share_cents, s.settled, s.settled_at::text, s.note
           FROM transaction_shares s
           JOIN split_participants p ON p.id = s.participant_id
          WHERE s.transaction_id = $1
          ORDER BY p.name`,
        [req.params.id],
      );
      const sumShares = shares.rows.reduce(
        (acc, r) => acc + Number((r as { share_cents: number }).share_cents),
        0,
      );
      return {
        transactionAmountCents: Number(txn.rows[0]!.amount_cents),
        sharesTotalCents: sumShares,
        // Your remaining share (what's not allocated to anyone else).
        yourShareCents: Number(txn.rows[0]!.amount_cents) - sumShares,
        shares: shares.rows,
      };
    },
  );

  // Replace ALL shares for a transaction in one PUT. Idempotent.
  app.put<{
    Params: { id: string };
    Body: {
      shares: Array<{
        participantId: string;
        shareCents: number;
        note?: string;
      }>;
    };
  }>('/api/transactions/:id/shares', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const denyFeat = await requireFeature(tenantId, FEATURES.BILL_SPLITTING);
    if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
    if (!isUuid(req.params.id))
      return reply.code(400).send({ error: 'Invalid id' });
    const ctx = await loadUserContext(req.user!.id, tenantId);
    const denied = requireFinancialMutation(ctx);
    if (denied) return reply.code(denied.status).send({ error: denied.error });

    const txn = await pool.query<{ amount_cents: number }>(
      `SELECT t.amount_cents
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.id = $1 AND a.tenant_id = $2`,
      [req.params.id, tenantId],
    );
    if (txn.rowCount === 0)
      return reply.code(404).send({ error: 'Transaction not found' });
    const txnAmount = Number(txn.rows[0]!.amount_cents);

    const shares = req.body?.shares ?? [];
    if (!Array.isArray(shares))
      return reply.code(400).send({ error: 'shares[] required' });

    // Validate sign — every share has to be the same sign as the
    // transaction (a negative txn = spending you share with others;
    // a positive txn = an inflow you split with others, less common).
    // Zero shares are allowed for explicit "already paid" rows.
    for (const s of shares) {
      if (!isUuid(s.participantId))
        return reply.code(400).send({ error: 'Each share needs a UUID participantId' });
      if (!Number.isInteger(s.shareCents))
        return reply.code(400).send({ error: 'shareCents must be an integer' });
      if (txnAmount !== 0 && s.shareCents !== 0) {
        const sameSign =
          (txnAmount > 0 && s.shareCents > 0) ||
          (txnAmount < 0 && s.shareCents < 0);
        if (!sameSign) {
          return reply
            .code(400)
            .send({ error: "Share sign must match the transaction's sign" });
        }
      }
    }
    const totalShares = shares.reduce((a, s) => a + s.shareCents, 0);
    // Total can't exceed the transaction amount in magnitude.
    if (Math.abs(totalShares) > Math.abs(txnAmount)) {
      return reply
        .code(400)
        .send({ error: 'Total of shares exceeds the transaction amount' });
    }

    // Verify every participant id belongs to this tenant.
    if (shares.length > 0) {
      const ids = [...new Set(shares.map((s) => s.participantId))];
      const owned = await pool.query<{ id: string }>(
        `SELECT id FROM split_participants
          WHERE id = ANY($1) AND tenant_id = $2`,
        [ids, tenantId],
      );
      if (owned.rowCount !== ids.length) {
        return reply
          .code(400)
          .send({ error: 'One or more participants not found in this tenant' });
      }
    }

    const result = await withTransaction(async (client) => {
      await client.query(
        `DELETE FROM transaction_shares WHERE transaction_id = $1`,
        [req.params.id],
      );
      for (const s of shares) {
        if (s.shareCents === 0 && (s.note ?? '') === '') continue; // skip empty
        await client.query(
          `INSERT INTO transaction_shares
             (transaction_id, participant_id, share_cents, note)
           VALUES ($1, $2, $3, $4)`,
          [req.params.id, s.participantId, s.shareCents, s.note ?? null],
        );
      }
      return { written: shares.length };
    });

    await recordAudit({
      tenantId,
      actorUserId: req.user!.id,
      actorKind: 'tenant_user',
      action: 'shares.replace',
      targetKind: 'transaction',
      targetId: req.params.id,
      details: { shareCount: result.written },
    });
    return reply.send({ ok: true, written: result.written });
  });

  app.post<{ Params: { id: string }; Body: { settled?: boolean } }>(
    '/api/transaction-shares/:id/settle',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.BILL_SPLITTING);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      const denied = requireFinancialMutation(ctx);
      if (denied) return reply.code(denied.status).send({ error: denied.error });

      const settled = req.body?.settled !== false; // default true
      // Scope through the participant→tenant relationship so cross-
      // tenant ids can't be flipped.
      const r = await pool.query(
        `UPDATE transaction_shares s
            SET settled = $2,
                settled_at = CASE WHEN $2 THEN now() ELSE NULL END
           FROM split_participants p
          WHERE s.id = $1 AND s.participant_id = p.id AND p.tenant_id = $3
       RETURNING s.id, s.settled, s.settled_at::text`,
        [req.params.id, settled, tenantId],
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Share not found' });
      return { share: r.rows[0] };
    },
  );

  app.get('/api/shares/summary', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const denyFeat = await requireFeature(tenantId, FEATURES.BILL_SPLITTING);
    if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
    const r = await pool.query(
      `SELECT p.id AS participant_id, p.name AS participant_name,
              COALESCE(SUM(CASE WHEN s.settled = false THEN s.share_cents ELSE 0 END), 0)::bigint
                AS net_open_cents,
              COALESCE(SUM(s.share_cents), 0)::bigint AS net_all_cents,
              COUNT(s.id) FILTER (WHERE s.settled = false)::int AS open_count
         FROM split_participants p
         LEFT JOIN transaction_shares s ON s.participant_id = p.id
        WHERE p.tenant_id = $1 AND p.archived = false
        GROUP BY p.id, p.name
        ORDER BY p.name`,
      [tenantId],
    );
    return { summary: r.rows };
  });

  app.get<{ Querystring: { participantId?: string; onlyOpen?: string } }>(
    '/api/shares',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.BILL_SPLITTING);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const params: unknown[] = [tenantId];
      const where: string[] = ['p.tenant_id = $1'];
      if (req.query.participantId) {
        if (!isUuid(req.query.participantId))
          return reply.code(400).send({ error: 'Invalid participantId' });
        params.push(req.query.participantId);
        where.push(`p.id = $${params.length}`);
      }
      if (req.query.onlyOpen === '1') where.push(`s.settled = false`);
      const r = await pool.query(
        `SELECT s.id, s.transaction_id, s.share_cents, s.settled,
                s.settled_at::text, s.note, s.created_at::text,
                t.txn_date::text AS txn_date, t.raw_description,
                t.amount_cents AS txn_amount_cents,
                p.id AS participant_id, p.name AS participant_name
           FROM transaction_shares s
           JOIN split_participants p ON p.id = s.participant_id
           JOIN transactions t ON t.id = s.transaction_id
          WHERE ${where.join(' AND ')}
          ORDER BY s.created_at DESC
          LIMIT 200`,
        params,
      );
      return { shares: r.rows };
    },
  );
}
