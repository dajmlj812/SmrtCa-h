import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { isUuid } from '../util.js';

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

async function loadPendingSuggestion(id: string): Promise<SuggestionRow | null> {
  const result = await query<SuggestionRow>(
    `SELECT id, suggested_name, status, resolved_to_category_id, created_at, resolved_at
       FROM category_suggestions
      WHERE id = $1 AND status = 'pending'`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function suggestionRoutes(app: FastifyInstance): Promise<void> {
  // List suggestions. Defaults to pending; pass ?status=all|approved|rejected|merged for others.
  app.get<{ Querystring: { status?: string } }>(
    '/api/suggestions',
    async (req) => {
      const status = (req.query.status ?? 'pending').toLowerCase();
      const filter =
        status === 'all'
          ? null
          : ['pending', 'approved', 'rejected', 'merged'].includes(status)
            ? status
            : 'pending';

      const result = await query(
        `SELECT s.id, s.suggested_name, s.status,
                s.resolved_to_category_id, s.created_at, s.resolved_at,
                COUNT(t.id)::bigint AS transaction_count,
                c.name AS resolved_category_name
           FROM category_suggestions s
      LEFT JOIN transactions t ON t.suggested_category_name = s.suggested_name
      LEFT JOIN categories c   ON c.id = s.resolved_to_category_id
          WHERE ($1::text IS NULL OR s.status = $1)
       GROUP BY s.id, c.name
       ORDER BY s.status, s.created_at DESC`,
        [filter],
      );
      return { suggestions: result.rows };
    },
  );

  // Approve — create a brand-new category from the suggestion and relink
  // every transaction that was tagged with it.
  app.post<{ Params: { id: string }; Body: { parentId?: string | null } }>(
    '/api/suggestions/:id/approve',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;

      let parentId: string | null = null;
      if (body.parentId !== undefined && body.parentId !== null) {
        if (typeof body.parentId !== 'string' || !isUuid(body.parentId)) {
          return reply.code(400).send({ error: 'Invalid parentId' });
        }
        parentId = body.parentId;
      }

      const suggestion = await loadPendingSuggestion(req.params.id);
      if (!suggestion) {
        return reply
          .code(404)
          .send({ error: 'Pending suggestion not found' });
      }

      try {
        return await withTransaction(async (client) => {
          const newCat = await client.query<{
            id: string;
            name: string;
            parent_id: string | null;
          }>(
            `INSERT INTO categories (name, parent_id) VALUES ($1, $2)
             RETURNING id, name, parent_id`,
            [suggestion.suggested_name, parentId],
          );
          const newCategory = newCat.rows[0]!;
          await client.query(
            `UPDATE category_suggestions
                SET status = 'approved',
                    resolved_to_category_id = $1,
                    resolved_at = now()
              WHERE id = $2`,
            [newCategory.id, suggestion.id],
          );
          const linked = await client.query(
            `UPDATE transactions
                SET category_id = $1,
                    suggested_category_name = NULL,
                    normalization_status = 'normalized'
              WHERE suggested_category_name = $2`,
            [newCategory.id, suggestion.suggested_name],
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

  // Merge — link the suggestion (and its tagged transactions) to an
  // existing category instead of creating a new one.
  app.post<{ Params: { id: string }; Body: { categoryId?: string } }>(
    '/api/suggestions/:id/merge',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const categoryId = asString(body.categoryId);
      if (!categoryId || !isUuid(categoryId)) {
        return reply.code(400).send({ error: 'A valid categoryId is required' });
      }

      const suggestion = await loadPendingSuggestion(req.params.id);
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
            WHERE id = $2`,
          [categoryId, suggestion.id],
        );
        const linked = await client.query(
          `UPDATE transactions
              SET category_id = $1,
                  suggested_category_name = NULL,
                  normalization_status = 'normalized'
            WHERE suggested_category_name = $2`,
          [categoryId, suggestion.suggested_name],
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

  // Reject — mark the suggestion rejected and clear the suggestion tag on
  // tagged transactions (they keep whatever category they have, usually
  // Uncategorized).
  app.post<{ Params: { id: string } }>(
    '/api/suggestions/:id/reject',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const suggestion = await loadPendingSuggestion(req.params.id);
      if (!suggestion) {
        return reply
          .code(404)
          .send({ error: 'Pending suggestion not found' });
      }

      return withTransaction(async (client) => {
        await client.query(
          `UPDATE category_suggestions
              SET status = 'rejected', resolved_at = now()
            WHERE id = $1`,
          [suggestion.id],
        );
        const cleared = await client.query(
          `UPDATE transactions
              SET suggested_category_name = NULL
            WHERE suggested_category_name = $1`,
          [suggestion.suggested_name],
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
