import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { isUuid } from '../util.js';

const COLUMNS = `id, transaction_id, category_id, amount_cents, memo, created_at`;

/**
 * Transaction splits. When at least one split row exists for a
 * transaction, insights/budgets/CSV-export queries expand the
 * transaction into per-split lines instead of using its own category.
 *
 * Sum of split amount_cents must equal the parent transaction's
 * amount_cents — enforced in the PUT handler.
 */
export async function splitRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/transactions/:id/splits',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
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
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      const body = (req.body ?? {}) as { splits?: unknown };
      if (!Array.isArray(body.splits)) {
        return reply.code(400).send({ error: 'splits must be an array' });
      }

      const txn = await pool.query<{ id: string; amount_cents: number }>(
        `SELECT id, amount_cents FROM transactions WHERE id = $1`,
        [req.params.id],
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
               (transaction_id, category_id, amount_cents, memo)
             VALUES ($1, $2, $3, $4)
             RETURNING ${COLUMNS}`,
            [req.params.id, s.categoryId, s.amountCents, s.memo],
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
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      await query(`DELETE FROM transaction_splits WHERE transaction_id = $1`, [
        req.params.id,
      ]);
      return reply.code(204).send();
    },
  );
}
