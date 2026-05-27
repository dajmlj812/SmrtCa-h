import type { FastifyInstance } from 'fastify';
import { query, withTransaction } from '../db/pool.js';
import { isUuid } from '../util.js';
import { resetCanonicalCategories, seedDefaultCategories } from '../domain/categories.js';
import { canManageMembers, loadUserContext, requireTenant } from '../auth/rbac.js';

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
  //
  // 0.21.x — per-name override semantics. Every tenant row is
  // returned; global rows are only returned if their name isn't
  // already present in the tenant. This way a single stray tenant
  // row doesn't hide the entire global canonical taxonomy — only
  // the names the tenant has customised get overridden.
  app.get('/api/categories', async (req) => {
    const tenantId = req.user?.tenantId ?? null;
    const result = await query(
      `SELECT c.id, c.name, c.parent_id, c.tax_category, c.is_system, c.created_at,
              COUNT(t.id)::bigint AS transaction_count
         FROM categories c
    LEFT JOIN transactions t ON t.category_id = c.id
        WHERE c.tenant_id = $1::uuid
           OR (
             c.tenant_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM categories ct
                WHERE ct.tenant_id = $1::uuid
                  AND lower(ct.name) = lower(c.name)
             )
           )
     GROUP BY c.id
     ORDER BY c.is_system DESC, c.name`,
      [tenantId],
    );
    return { categories: result.rows };
  });

  /**
   * 0.21.x — Hard reset to canonical.
   *
   * Wipes every category in the caller's tenant (preserving
   * canonical NULL-tenant rows), nulls out category_id on
   * dependent rows that allow it, then reseeds canonical for the
   * tenant. Budgets cascade-delete with their category — the UI
   * warns about this before invoking.
   */
  app.post('/api/categories/reset', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const ctx = await loadUserContext(req.user!.id, tenantId);
    if (!canManageMembers(ctx)) {
      return reply
        .code(403)
        .send({ error: 'Only tenant admins may reset categories' });
    }
    const result = await withTransaction(async (client) => {
      // First, make sure the global canonical rows exist (idempotent).
      await seedDefaultCategories(client, null);
      // Then reset the tenant's customs and reseed scoped copies.
      return resetCanonicalCategories(client, tenantId);
    });
    return { ...result, ok: true };
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
