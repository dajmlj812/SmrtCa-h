import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { isUuid } from '../util.js';
import {
  assertCategoryUsableByTenant,
  assertTransactionInTenant,
  requireTenant,
} from '../auth/rbac.js';

const COLUMNS = `id, transaction_id, category_id, amount_cents, memo, created_at`;

/**
 * Transaction splits. When at least one split row exists for a
 * transaction, insights/budgets/CSV-export queries expand the
 * transaction into per-split lines instead of using its own category.
 *
 * Sum of split amount_cents must equal the parent transaction's
 * amount_cents — enforced in the PUT handler.
 *
 * 0.14.3 — every route verifies the parent transaction belongs to
 * the caller's tenant; PUT validates each per-split `categoryId`
 * against the tenant (so a child can't smuggle another tenant's
 * category onto a split). INSERTs write `transaction_splits.tenant_id`
 * (Phase 8 column was never populated by this route pre-fix).
 */
export async function splitRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/transactions/:id/splits',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      const ok = await assertTransactionInTenant(tenantId, req.params.id);
      if (!ok) return reply.code(404).send({ error: 'Transaction not found' });
      const r = await query(
        `SELECT s.${COLUMNS.replace(/, /g, ', s.')}, c.name AS category_name
           FROM transaction_splits s
      LEFT JOIN categories c ON c.id = s.category_id
          WHERE s.transaction_id = $1
       ORDER BY s.created_at`,
        [req.params.id],
      );
      return { splits: r.rows };
    },
  );

  // Replace all splits for a transaction. Pass an empty array to clear.
  app.put<{ Params: { id: string } }>(
    '/api/transactions/:id/splits',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      const body = (req.body ?? {}) as { splits?: unknown };
      if (!Array.isArray(body.splits)) {
        return reply.code(400).send({ error: 'splits must be an array' });
      }

      // Look up the parent txn scoped to this tenant — same shape as
      // assertTransactionInTenant but we also need amount_cents for
      // the sum check.
      const txn = await pool.query<{ id: string; amount_cents: number }>(
        `SELECT t.id, t.amount_cents
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE t.id = $1 AND a.tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (txn.rowCount === 0) {
        return reply.code(404).send({ error: 'Transaction not found' });
      }

      // Empty array clears splits entirely.
      if (body.splits.length === 0) {
        await query(`DELETE FROM transaction_splits WHERE transaction_id = $1`, [
          req.params.id,
        ]);
        return { splits: [] };
      }

      // Validate each split.
      interface SplitInput {
        categoryId: string | null;
        amountCents: number;
        memo: string | null;
      }
      const parsed: SplitInput[] = [];
      for (const raw of body.splits) {
        const s = raw as {
          categoryId?: unknown;
          amountCents?: unknown;
          memo?: unknown;
        };
        let categoryId: string | null = null;
        if (s.categoryId !== undefined && s.categoryId !== null) {
          if (typeof s.categoryId !== 'string' || !isUuid(s.categoryId)) {
            return reply.code(400).send({ error: 'Invalid categoryId in splits' });
          }
          // Reject cross-tenant categoryId — a tenant can't attach
          // another tenant's category to its own splits.
          const cok = await assertCategoryUsableByTenant(tenantId, s.categoryId);
          if (!cok) {
            return reply.code(400).send({ error: 'Invalid categoryId in splits' });
          }
          categoryId = s.categoryId;
        }
        const amt = typeof s.amountCents === 'number' ? s.amountCents : Number(s.amountCents);
        if (!Number.isInteger(amt) || amt === 0) {
          return reply
            .code(400)
            .send({ error: 'Each split.amountCents must be a non-zero integer' });
        }
        parsed.push({
          categoryId,
          amountCents: amt,
          memo: typeof s.memo === 'string' && s.memo.trim() !== '' ? s.memo.trim() : null,
        });
      }

      const total = parsed.reduce((acc, s) => acc + s.amountCents, 0);
      if (total !== Number(txn.rows[0]!.amount_cents)) {
        return reply.code(400).send({
          error: `Split amounts (${total}) must sum to the transaction amount (${txn.rows[0]!.amount_cents})`,
        });
      }

      const inserted = await withTransaction(async (client) => {
        await client.query(`DELETE FROM transaction_splits WHERE transaction_id = $1`, [
          req.params.id,
        ]);
        const rows: unknown[] = [];
        for (const s of parsed) {
          const r = await client.query(
            `INSERT INTO transaction_splits
               (tenant_id, transaction_id, category_id, amount_cents, memo)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING ${COLUMNS}`,
            [tenantId, req.params.id, s.categoryId, s.amountCents, s.memo],
          );
          rows.push(r.rows[0]);
        }
        return rows;
      });

      return { splits: inserted };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/transactions/:id/splits',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      const ok = await assertTransactionInTenant(tenantId, req.params.id);
      if (!ok) return reply.code(404).send({ error: 'Transaction not found' });
      await query(`DELETE FROM transaction_splits WHERE transaction_id = $1`, [
        req.params.id,
      ]);
      return reply.code(204).send();
    },
  );
}
