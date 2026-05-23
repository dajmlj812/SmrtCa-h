import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';

interface TransactionQuery {
  accountId?: string;
  search?: string;
  limit?: string;
  offset?: string;
}

interface ExportQuery {
  accountId?: string;
  search?: string;
  start?: string;
  end?: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Quote-and-escape one CSV cell. Always-quote keeps the encoder dead simple. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const s = String(value).replace(/"/g, '""');
  return `"${s}"`;
}

/** Format integer cents as a fixed-2 decimal string. */
function centsToDecimal(cents: number | null): string {
  if (cents === null || cents === undefined) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}${dollars}.${String(remainder).padStart(2, '0')}`;
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

      // running_balance_cents is computed in an inner query (against the
      // full account history, ignoring the search filter) so the value is
      // correct independent of how the outer view is filtered. NULL for
      // transactions that pre-date opening_balance_date.
      const rows = await query(
        `SELECT t.id, t.account_id, t.txn_date, t.post_date, t.amount_cents,
                t.raw_description, t.source_category, t.source_type, t.memo,
                t.balance_cents, t.normalized_merchant, t.category_id,
                t.normalization_status, t.transfer_group_id, t.created_at,
                t.account_name, t.category_name, t.attachment_count,
                t.running_balance_cents
           FROM (
             SELECT t.*,
                    a.name AS account_name,
                    c.name AS category_name,
                    (SELECT COUNT(*)::int FROM attachments
                      WHERE transaction_id = t.id) AS attachment_count,
                    CASE
                      WHEN a.opening_balance_date IS NULL
                        OR t.txn_date >= a.opening_balance_date
                      THEN a.opening_balance_cents + SUM(t.amount_cents) FILTER (
                             WHERE a.opening_balance_date IS NULL
                                OR t.txn_date >= a.opening_balance_date
                           ) OVER (
                             PARTITION BY t.account_id
                             ORDER BY t.txn_date ASC, t.created_at ASC
                             ROWS UNBOUNDED PRECEDING
                           )
                      ELSE NULL
                    END::bigint AS running_balance_cents
               FROM transactions t
               JOIN accounts a ON a.id = t.account_id
          LEFT JOIN categories c ON c.id = t.category_id
           ) t
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

  // Filtered CSV export. Shares the list endpoint's filter shape and adds
  // optional start/end date bounds. Returned as text/csv with a date-stamped
  // download filename.
  app.get<{ Querystring: ExportQuery }>(
    '/api/transactions/export',
    async (req, reply) => {
      const accountId = req.query.accountId?.trim() || null;
      if (accountId && !isUuid(accountId)) {
        return reply.code(400).send({ error: 'Invalid accountId' });
      }
      const search = req.query.search?.trim() || null;
      const start = req.query.start?.trim() || null;
      const end = req.query.end?.trim() || null;
      const ymd = /^\d{4}-\d{2}-\d{2}$/;
      if (start && !ymd.test(start)) {
        return reply.code(400).send({ error: 'start must be YYYY-MM-DD' });
      }
      if (end && !ymd.test(end)) {
        return reply.code(400).send({ error: 'end must be YYYY-MM-DD' });
      }

      const rows = await query<{
        txn_date: string;
        account_name: string;
        raw_description: string;
        normalized_merchant: string | null;
        category_name: string | null;
        amount_cents: number;
        normalization_status: string;
        memo: string | null;
        running_balance_cents: number | null;
        is_transfer: boolean;
      }>(
        `SELECT t.txn_date,
                a.name AS account_name,
                t.raw_description,
                t.normalized_merchant,
                c.name AS category_name,
                t.amount_cents,
                t.normalization_status,
                t.memo,
                (t.transfer_group_id IS NOT NULL) AS is_transfer,
                CASE
                  WHEN a.opening_balance_date IS NULL
                    OR t.txn_date >= a.opening_balance_date
                  THEN a.opening_balance_cents + SUM(t.amount_cents) FILTER (
                         WHERE a.opening_balance_date IS NULL
                            OR t.txn_date >= a.opening_balance_date
                       ) OVER (
                         PARTITION BY t.account_id
                         ORDER BY t.txn_date ASC, t.created_at ASC
                         ROWS UNBOUNDED PRECEDING
                       )
                  ELSE NULL
                END::bigint AS running_balance_cents
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
      LEFT JOIN categories c ON c.id = t.category_id
          WHERE ($1::uuid IS NULL OR t.account_id = $1)
            AND ($2::text IS NULL OR t.raw_description ILIKE '%' || $2 || '%')
            AND ($3::date IS NULL OR t.txn_date >= $3)
            AND ($4::date IS NULL OR t.txn_date <= $4)
       ORDER BY t.txn_date DESC, t.created_at DESC`,
        [accountId, search, start, end],
      );

      const header = [
        'Date',
        'Account',
        'Description',
        'Merchant',
        'Category',
        'Amount',
        'Running Balance',
        'Status',
        'Transfer',
        'Memo',
      ];
      const lines: string[] = [header.map(csvCell).join(',')];
      for (const r of rows.rows) {
        lines.push(
          [
            csvCell(r.txn_date),
            csvCell(r.account_name),
            csvCell(r.raw_description),
            csvCell(r.normalized_merchant),
            csvCell(r.category_name),
            csvCell(centsToDecimal(r.amount_cents)),
            csvCell(centsToDecimal(r.running_balance_cents)),
            csvCell(r.normalization_status),
            csvCell(r.is_transfer ? 'yes' : 'no'),
            csvCell(r.memo),
          ].join(','),
        );
      }
      const body = lines.join('\r\n') + '\r\n';

      const today = new Date().toISOString().slice(0, 10);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header(
        'Content-Disposition',
        `attachment; filename="smrtcash-transactions-${today}.csv"`,
      );
      return reply.send(body);
    },
  );
}
