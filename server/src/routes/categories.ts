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

/**
 * Suggested tax-category vocabulary for the UI's datalist. Free-text
 * server-side — these are just hints. Mirrors the most common US
 * Schedule A itemized deductions + a few Schedule C lines so a
 * typical household tagging is one click of a suggestion.
 */
export const SUGGESTED_TAX_CATEGORIES: string[] = [
  'Charitable Donations',
  'Medical Expenses',
  'State/Local Income Tax',
  'Property Tax',
  'Mortgage Interest',
  'Student Loan Interest',
  'Childcare Expenses',
  'Tuition / Education',
  'Investment Interest',
  'Wages (W-2)',
  '1099 Income',
  'Self-Employment Income',
  'Business Expense — Office',
  'Business Expense — Travel',
  'Business Expense — Supplies',
  'Business Expense — Other',
];

export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  // List categories, with how many transactions reference each.
  app.get('/api/categories', async () => {
    const result = await query(`
      SELECT c.id, c.name, c.parent_id, c.tax_category, c.created_at,
             COUNT(t.id)::bigint AS transaction_count
        FROM categories c
   LEFT JOIN transactions t ON t.category_id = c.id
    GROUP BY c.id
    ORDER BY c.name
    `);
    return { categories: result.rows };
  });

  app.get('/api/categories/tax-vocabulary', async () => ({
    suggestions: SUGGESTED_TAX_CATEGORIES,
  }));

  app.post('/api/categories', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asString(body.name);
    const taxCategory = asString(body.tax_category) || null;
    if (name === '') {
      return reply.code(400).send({ error: 'name is required' });
    }
    try {
      const result = await query(
        `INSERT INTO categories (name, tax_category) VALUES ($1, $2)
         RETURNING id, name, parent_id, tax_category, created_at`,
        [name, taxCategory],
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
      // Build the update set so callers can patch name OR
      // tax_category in isolation. Empty-string tax_category clears.
      const sets: string[] = [];
      const params: unknown[] = [];
      if (typeof body.name === 'string') {
        const name = asString(body.name);
        if (name === '') {
          return reply.code(400).send({ error: 'name cannot be empty' });
        }
        params.push(name);
        sets.push(`name = $${params.length}`);
      }
      if ('tax_category' in body) {
        const tc = asString(body.tax_category);
        params.push(tc === '' ? null : tc);
        sets.push(`tax_category = $${params.length}`);
      }
      if (sets.length === 0) {
        return reply.code(400).send({ error: 'No updatable fields' });
      }
      params.push(req.params.id);
      try {
        const result = await query(
          `UPDATE categories SET ${sets.join(', ')}
             WHERE id = $${params.length}
           RETURNING id, name, parent_id, tax_category, created_at`,
          params,
        );
        if (result.rowCount === 0) {
          return reply.code(404).send({ error: 'Category not found' });
        }
        return { category: result.rows[0] };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: 'Category name conflict' });
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
