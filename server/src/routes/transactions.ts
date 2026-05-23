import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';
import {
  assertAccountWriteAccess,
  loadUserContext,
  scopedAccountIds,
} from '../auth/rbac.js';

interface TransactionQuery {
  accountId?: string;
  search?: string;
  limit?: string;
  offset?: string;
  uncategorized?: string;
  /** Phase 9.3: inclusive date filters (YYYY-MM-DD). */
  startDate?: string;
  endDate?: string;
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
  // Bulk-delete. Removes the listed transactions; splits and attachments
  // cascade via FK. transfer_group_id partners become lone rows — that's
  // a display quirk but not a correctness issue.
  app.post('/api/transactions/bulk-delete', async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return reply.code(400).send({ error: 'ids must be a non-empty array' });
    }
    const ids: string[] = [];
    for (const id of body.ids) {
      if (typeof id !== 'string' || !isUuid(id)) {
        return reply.code(400).send({ error: `Invalid transaction id: ${String(id)}` });
      }
      ids.push(id);
    }
    const r = await query(
      `DELETE FROM transactions WHERE id = ANY($1::uuid[]) RETURNING id`,
      [ids],
    );
    return { deleted: r.rowCount ?? 0 };
  });

  // Bulk-edit. The body lists transaction ids and the fields to apply
  // uniformly. All matched rows flip to normalization_status='manual'
  // because the user is making an explicit assignment.
  app.patch('/api/transactions/bulk', async (req, reply) => {
    const body = (req.body ?? {}) as {
      ids?: unknown;
      updates?: { categoryId?: unknown; merchant?: unknown };
    };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return reply.code(400).send({ error: 'ids must be a non-empty array' });
    }
    const ids: string[] = [];
    for (const id of body.ids) {
      if (typeof id !== 'string' || !isUuid(id)) {
        return reply.code(400).send({ error: `Invalid transaction id: ${String(id)}` });
      }
      ids.push(id);
    }
    const updates = body.updates ?? {};
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.merchant !== undefined) {
      const m = asString(updates.merchant) || null;
      params.push(m);
      setClauses.push(`normalized_merchant = $${params.length}`);
    }
    if (updates.categoryId !== undefined) {
      if (updates.categoryId === null) {
        params.push(null);
      } else if (typeof updates.categoryId === 'string' && isUuid(updates.categoryId)) {
        params.push(updates.categoryId);
      } else {
        return reply.code(400).send({ error: 'Invalid categoryId' });
      }
      setClauses.push(`category_id = $${params.length}`);
    }
    if (setClauses.length === 0) {
      return reply.code(400).send({ error: 'No updates provided' });
    }

    setClauses.push(`normalization_status = 'manual'`);
    params.push(ids);
    const r = await query(
      `UPDATE transactions SET ${setClauses.join(', ')}
        WHERE id = ANY($${params.length}::uuid[])
     RETURNING id`,
      params,
    );
    return { updated: r.rowCount ?? 0, ids: r.rows.map((row) => (row as { id: string }).id) };
  });

  // Manual edit — sets normalization_status to 'manual' so AI re-runs leave
  // the row alone.
  app.patch<{ Params: { id: string } }>(
    '/api/transactions/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid transaction id' });
      }
      // 0.13.4: per-account write gate. Look up the transaction's
      // account, then ask rbac whether this user can write to it.
      const owner = await query<{ account_id: string }>(
        `SELECT account_id FROM transactions WHERE id = $1`,
        [req.params.id],
      );
      if (owner.rowCount === 0) {
        return reply.code(404).send({ error: 'Transaction not found' });
      }
      if (req.user) {
        const ctx = await loadUserContext(req.user.id, req.user.tenantId);
        const denied = await assertAccountWriteAccess(
          ctx,
          owner.rows[0]!.account_id,
        );
        if (denied) {
          return reply.code(denied.status).send({ error: denied.error });
        }
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
      const startDate = req.query.startDate?.trim() || null;
      const endDate = req.query.endDate?.trim() || null;
      const isoDate = /^\d{4}-\d{2}-\d{2}$/;
      if (startDate && !isoDate.test(startDate)) {
        return reply.code(400).send({ error: 'startDate must be YYYY-MM-DD' });
      }
      if (endDate && !isoDate.test(endDate)) {
        return reply.code(400).send({ error: 'endDate must be YYYY-MM-DD' });
      }
      // Child role: scope to accounts the admin assigned. If they
      // asked for a specific account they don't have access to, return
      // an empty page rather than 403 — the inline filter wouldn't
      // have surfaced it on the frontend in the first place.
      let scopedIds: string[] | null = null;
      if (req.user) {
        const ctx = await loadUserContext(req.user.id, req.user.tenantId);
        scopedIds = await scopedAccountIds(ctx);
      }
      if (scopedIds) {
        if (scopedIds.length === 0) {
          return { transactions: [], total: 0, limit, offset };
        }
        if (accountId && !scopedIds.includes(accountId)) {
          return { transactions: [], total: 0, limit, offset };
        }
      }
      // Uncategorized = no direct category AND no splits. A split-only row
      // is considered categorized via its slices.
      // "Uncategorized" means: no direct category OR the row points at
      // the literal 'Uncategorized' category (the AI normalizer parks
      // anything it can't classify there rather than leaving it NULL).
      // Either way, no splits — a split-only row is categorized via its
      // slices.
      const uncategorized = req.query.uncategorized === 'true';

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
           AND ($5::boolean = FALSE OR (
             (t.category_id IS NULL
              OR t.category_id = (SELECT id FROM categories WHERE name = 'Uncategorized' AND parent_id IS NULL LIMIT 1))
             AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
           ))
           AND ($6::uuid[] IS NULL OR t.account_id = ANY($6::uuid[]))
           AND ($7::date IS NULL OR t.txn_date >= $7)
           AND ($8::date IS NULL OR t.txn_date <= $8)
         ORDER BY t.txn_date DESC, t.created_at DESC
         LIMIT $3 OFFSET $4`,
        [accountId, search, limit, offset, uncategorized, scopedIds, startDate, endDate],
      );

      const count = await query<{ total: number }>(
        `SELECT COUNT(*)::bigint AS total
         FROM transactions t
         WHERE ($1::uuid IS NULL OR t.account_id = $1)
           AND ($2::text IS NULL OR t.raw_description ILIKE '%' || $2 || '%')
           AND ($3::boolean = FALSE OR (
             (t.category_id IS NULL
              OR t.category_id = (SELECT id FROM categories WHERE name = 'Uncategorized' AND parent_id IS NULL LIMIT 1))
             AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
           ))
           AND ($4::uuid[] IS NULL OR t.account_id = ANY($4::uuid[]))
           AND ($5::date IS NULL OR t.txn_date >= $5)
           AND ($6::date IS NULL OR t.txn_date <= $6)`,
        [accountId, search, uncategorized, scopedIds, startDate, endDate],
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
