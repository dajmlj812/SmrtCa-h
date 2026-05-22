import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';

interface TransactionQuery {
  accountId?: string;
  search?: string;
  limit?: string;
  offset?: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  // Manual edit — sets normalization_status to 'manual' so AI re-runs leave
  // the row alone.
  app.patch<{ Params: { id: string } }>(
    '/api/transactions/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;

      const updates: string[] = [];
      const params: unknown[] = [];

      if (body.merchant !== undefined) {
        const merchant = asString(body.merchant) || null;
        params.push(merchant);
        updates.push(`normalized_merchant = $${params.length}`);
      }

      if (body.categoryId !== undefined) {
        if (body.categoryId === null) {
          params.push(null);
        } else if (
          typeof body.categoryId === 'string' &&
          isUuid(body.categoryId)
        ) {
          params.push(body.categoryId);
        } else {
          return reply.code(400).send({ error: 'Invalid categoryId' });
        }
        updates.push(`category_id = $${params.length}`);
      }

      if (updates.length === 0) {
        return reply
          .code(400)
          .send({ error: 'No updatable fields provided' });
      }

      updates.push(`normalization_status = 'manual'`);
      params.push(req.params.id);

      const result = await query(
        `UPDATE transactions SET ${updates.join(', ')}
          WHERE id = $${params.length}
       RETURNING id, account_id, txn_date, post_date, amount_cents,
                 raw_description, source_category, source_type, memo,
                 balance_cents, normalized_merchant, category_id,
                 normalization_status, normalization_note, created_at`,
        params,
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Transaction not found' });
      }
      return { transaction: result.rows[0] };
    },
  );

  app.get<{ Querystring: TransactionQuery }>(
    '/api/transactions',
    async (req, reply) => {
      const accountId = req.query.accountId?.trim() || null;
      if (accountId && !isUuid(accountId)) {
        return reply.code(400).send({ error: 'Invalid accountId' });
      }
      const search = req.query.search?.trim() || null;
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      const rows = await query(
        `SELECT t.id, t.account_id, t.txn_date, t.post_date, t.amount_cents,
                t.raw_description, t.source_category, t.source_type, t.memo,
                t.balance_cents, t.normalized_merchant, t.category_id,
                t.normalization_status, t.created_at,
                a.name AS account_name,
                c.name AS category_name,
                (SELECT COUNT(*)::int FROM attachments
                  WHERE transaction_id = t.id) AS attachment_count
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE ($1::uuid IS NULL OR t.account_id = $1)
           AND ($2::text IS NULL OR t.raw_description ILIKE '%' || $2 || '%')
         ORDER BY t.txn_date DESC, t.created_at DESC
         LIMIT $3 OFFSET $4`,
        [accountId, search, limit, offset],
      );

      const count = await query<{ total: number }>(
        `SELECT COUNT(*)::bigint AS total
         FROM transactions t
         WHERE ($1::uuid IS NULL OR t.account_id = $1)
           AND ($2::text IS NULL OR t.raw_description ILIKE '%' || $2 || '%')`,
        [accountId, search],
      );

      return {
        transactions: rows.rows,
        total: count.rows[0]?.total ?? 0,
        limit,
        offset,
      };
    },
  );
}
