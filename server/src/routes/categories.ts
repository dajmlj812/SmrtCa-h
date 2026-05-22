import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
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

export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  // List categories, with how many transactions reference each.
  app.get('/api/categories', async () => {
    const result = await query(`
      SELECT c.id, c.name, c.parent_id, c.created_at,
             COUNT(t.id)::bigint AS transaction_count
        FROM categories c
   LEFT JOIN transactions t ON t.category_id = c.id
    GROUP BY c.id
    ORDER BY c.name
    `);
    return { categories: result.rows };
  });

  app.post('/api/categories', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asString(body.name);
    if (name === '') {
      return reply.code(400).send({ error: 'name is required' });
    }
    try {
      const result = await query(
        `INSERT INTO categories (name) VALUES ($1)
         RETURNING id, name, parent_id, created_at`,
        [name],
      );
      return reply.code(201).send({ category: result.rows[0] });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply
          .code(409)
          .send({ error: `Category "${name}" already exists` });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/api/categories/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid category id' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = asString(body.name);
      if (name === '') {
        return reply.code(400).send({ error: 'name is required' });
      }
      try {
        const result = await query(
          `UPDATE categories SET name = $1 WHERE id = $2
           RETURNING id, name, parent_id, created_at`,
          [name, req.params.id],
        );
        if (result.rowCount === 0) {
          return reply.code(404).send({ error: 'Category not found' });
        }
        return { category: result.rows[0] };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply
            .code(409)
            .send({ error: `Category "${name}" already exists` });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/categories/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid category id' });
      }
      // Transactions referencing this category have their category_id set to
      // NULL automatically (FK ON DELETE SET NULL).
      const result = await query('DELETE FROM categories WHERE id = $1', [
        req.params.id,
      ]);
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Category not found' });
      }
      return reply.code(204).send();
    },
  );
}
