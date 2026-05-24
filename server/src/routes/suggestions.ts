import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { isUuid } from '../util.js';
import {
  assertCategoryUsableByTenant,
  requireTenant,
} from '../auth/rbac.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

interface SuggestionRow {
  id: string;
  suggested_name: string;
  status: string;
  resolved_to_category_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

async function loadPendingSuggestion(
  id: string,
  tenantId: string,
): Promise<SuggestionRow | null> {
  const result = await query<SuggestionRow>(
    `SELECT id, suggested_name, status, resolved_to_category_id, created_at, resolved_at
       FROM category_suggestions
      WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
    [id, tenantId],
  );
  return result.rows[0] ?? null;
}

/**
 * 0.14.3 — category_suggestions hardened end-to-end.
 *
 * Pre-fix: list returned every tenant's suggestions; approve/merge/
 * reject loaded suggestions by id with no ownership check; the
 * downstream transactions UPDATE inside approve/merge/reject ran
 * GLOBALLY (every tenant whose txn had a matching
 * `suggested_category_name` got relinked); and approve INSERTed a
 * new categories row WITHOUT tenant_id, leaking the suggested name
 * as a global category.
 *
 * Now every endpoint scopes by `req.user.tenantId`. The new
 * category gets a tenant_id; the relink/clear UPDATEs only touch
 * transactions whose account belongs to this tenant; categories
 * supplied for merge are validated against the tenant.
 */
export async function suggestionRoutes(app: FastifyInstance): Promise<void> {
  // List suggestions. Defaults to pending; pass ?status=all|approved|rejected|merged for others.
  app.get<{ Querystring: { status?: string } }>(
    '/api/suggestions',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const status = (req.query.status ?? 'pending').toLowerCase();
      const filter =
        status === 'all'
          ? null
          : ['pending', 'approved', 'rejected', 'merged'].includes(status)
            ? status
            : 'pending';

      // Two scoping mechanisms: the suggestion row itself is filtered
      // by tenant_id, and the joined transactions count joins through
      // accounts on the same tenant so a global suggested_category_name
      // shared with another tenant doesn't pollute this tenant's count.
      const result = await query(
        `SELECT s.id, s.suggested_name, s.status,
                s.resolved_to_category_id, s.created_at, s.resolved_at,
                (SELECT COUNT(t.id)::bigint
                   FROM transactions t
                   JOIN accounts a ON a.id = t.account_id
                  WHERE a.tenant_id = $1
                    AND t.suggested_category_name = s.suggested_name) AS transaction_count,
                c.name AS resolved_category_name
           FROM category_suggestions s
      LEFT JOIN categories c ON c.id = s.resolved_to_category_id
          WHERE s.tenant_id = $1
            AND ($2::text IS NULL OR s.status = $2)
       ORDER BY s.status, s.created_at DESC`,
        [tenantId, filter],
      );
      return { suggestions: result.rows };
    },
  );

  // Approve — create a brand-new category from the suggestion and relink
  // every transaction (in this tenant) that was tagged with it.
  app.post<{ Params: { id: string }; Body: { parentId?: string | null } }>(
    '/api/suggestions/:id/approve',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;

      let parentId: string | null = null;
      if (body.parentId !== undefined && body.parentId !== null) {
        if (typeof body.parentId !== 'string' || !isUuid(body.parentId)) {
          return reply.code(400).send({ error: 'Invalid parentId' });
        }
        const ok = await assertCategoryUsableByTenant(tenantId, body.parentId);
        if (!ok) return reply.code(400).send({ error: 'Invalid parentId' });
        parentId = body.parentId;
      }

      const suggestion = await loadPendingSuggestion(req.params.id, tenantId);
      if (!suggestion) {
        return reply
          .code(404)
          .send({ error: 'Pending suggestion not found' });
      }

      try {
        return await withTransaction(async (client) => {
          // New category carries the tenant_id so it's a per-tenant
          // category, not global. Pre-0.14.3 this INSERT omitted
          // tenant_id and the row appeared in every other tenant's
          // categories list.
          const newCat = await client.query<{
            id: string;
            name: string;
            parent_id: string | null;
          }>(
            `INSERT INTO categories (tenant_id, name, parent_id)
             VALUES ($1, $2, $3)
             RETURNING id, name, parent_id`,
            [tenantId, suggestion.suggested_name, parentId],
          );
          const newCategory = newCat.rows[0]!;
          await client.query(
            `UPDATE category_suggestions
                SET status = 'approved',
                    resolved_to_category_id = $1,
                    resolved_at = now()
              WHERE id = $2 AND tenant_id = $3`,
            [newCategory.id, suggestion.id, tenantId],
          );
          // Relink only THIS TENANT's transactions. Pre-fix this UPDATE
          // touched every tenant's matching rows.
          const linked = await client.query(
            `UPDATE transactions
                SET category_id = $1,
                    suggested_category_name = NULL,
                    normalization_status = 'normalized'
              WHERE suggested_category_name = $2
                AND account_id IN (SELECT id FROM accounts WHERE tenant_id = $3)`,
            [newCategory.id, suggestion.suggested_name, tenantId],
          );
          return {
            suggestion: {
              ...suggestion,
              status: 'approved',
              resolved_to_category_id: newCategory.id,
            },
            category: newCategory,
            transactionsRelinked: linked.rowCount ?? 0,
          };
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({
            error: `A category named "${suggestion.suggested_name}" already exists — use Merge instead`,
          });
        }
        throw err;
      }
    },
  );

  // Merge — link the suggestion (and its tagged transactions in THIS
  // tenant) to an existing category. The target category must be
  // usable by this tenant (global OR tenant-owned).
  app.post<{ Params: { id: string }; Body: { categoryId?: string } }>(
    '/api/suggestions/:id/merge',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const categoryId = asString(body.categoryId);
      if (!categoryId || !isUuid(categoryId)) {
        return reply.code(400).send({ error: 'A valid categoryId is required' });
      }
      const cok = await assertCategoryUsableByTenant(tenantId, categoryId);
      if (!cok) {
        return reply.code(404).send({ error: 'Target category not found' });
      }

      const suggestion = await loadPendingSuggestion(req.params.id, tenantId);
      if (!suggestion) {
        return reply
          .code(404)
          .send({ error: 'Pending suggestion not found' });
      }

      return withTransaction(async (client) => {
        const cat = await client.query<{ id: string; name: string }>(
          'SELECT id, name FROM categories WHERE id = $1',
          [categoryId],
        );
        if (cat.rowCount === 0) {
          reply.code(404);
          throw new Error('Target category not found');
        }
        await client.query(
          `UPDATE category_suggestions
              SET status = 'merged',
                  resolved_to_category_id = $1,
                  resolved_at = now()
            WHERE id = $2 AND tenant_id = $3`,
          [categoryId, suggestion.id, tenantId],
        );
        const linked = await client.query(
          `UPDATE transactions
              SET category_id = $1,
                  suggested_category_name = NULL,
                  normalization_status = 'normalized'
            WHERE suggested_category_name = $2
              AND account_id IN (SELECT id FROM accounts WHERE tenant_id = $3)`,
          [categoryId, suggestion.suggested_name, tenantId],
        );
        return {
          suggestion: {
            ...suggestion,
            status: 'merged',
            resolved_to_category_id: categoryId,
          },
          mergedTo: cat.rows[0],
          transactionsRelinked: linked.rowCount ?? 0,
        };
      });
    },
  );

  // Reject — mark the suggestion rejected and clear the suggestion tag
  // on this tenant's tagged transactions only.
  app.post<{ Params: { id: string } }>(
    '/api/suggestions/:id/reject',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const suggestion = await loadPendingSuggestion(req.params.id, tenantId);
      if (!suggestion) {
        return reply
          .code(404)
          .send({ error: 'Pending suggestion not found' });
      }

      return withTransaction(async (client) => {
        await client.query(
          `UPDATE category_suggestions
              SET status = 'rejected', resolved_at = now()
            WHERE id = $1 AND tenant_id = $2`,
          [suggestion.id, tenantId],
        );
        const cleared = await client.query(
          `UPDATE transactions
              SET suggested_category_name = NULL
            WHERE suggested_category_name = $1
              AND account_id IN (SELECT id FROM accounts WHERE tenant_id = $2)`,
          [suggestion.suggested_name, tenantId],
        );
        return {
          suggestion: { ...suggestion, status: 'rejected' },
          transactionsCleared: cleared.rowCount ?? 0,
        };
      });
    },
  );
}

// Re-export pool so this file participates in the same module graph.
export { pool };
