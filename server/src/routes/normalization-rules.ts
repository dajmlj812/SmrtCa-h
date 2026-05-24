import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';

const COLUMNS = `id, pattern, normalized_merchant, category_id, source,
  enabled, priority, match_count, last_applied_at, created_at, tenant_id`;

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function requireTenant(req: FastifyRequest, reply: FastifyReply): string | null {
  if (!req.user) {
    reply.code(401).send({ error: 'Not authenticated' });
    return null;
  }
  if (!req.user.tenantId) {
    reply.code(403).send({ error: 'No active tenant' });
    return null;
  }
  return req.user.tenantId;
}

/**
 * Learned normalization rules (0.13.6 — tenant-scoped, runs on import).
 *
 * Each row is a substring pattern that, when present in a transaction's
 * raw_description, applies a normalized merchant name and/or category.
 * Rules are created from manual edits via the "Apply to similar?"
 * prompt in the web UI, and run automatically during every import
 * (see `persistBatch()` in `import/importer.ts`).
 *
 * `normalization_status='manual'` rows are skipped by the auto-apply
 * pass so a user's explicit override never gets overwritten. The
 * manual apply route accepts `includeManual: true` to override that.
 *
 * Every route is scoped to `req.user.tenantId` so a rule created by
 * one household never affects another.
 */
export async function normalizationRuleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/normalization-rules', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const r = await query(
      `SELECT ${COLUMNS} FROM normalization_rules
        WHERE tenant_id = $1
        ORDER BY priority ASC, created_at DESC`,
      [tenantId],
    );
    return { rules: r.rows };
  });

  app.post('/api/normalization-rules', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as {
      pattern?: unknown;
      normalizedMerchant?: unknown;
      categoryId?: unknown;
      enabled?: unknown;
      priority?: unknown;
    };
    const pattern = asString(body.pattern);
    if (pattern === '' || pattern.length < 2) {
      return reply.code(400).send({ error: 'pattern must be ≥ 2 characters' });
    }
    const merchant =
      body.normalizedMerchant === undefined || body.normalizedMerchant === null
        ? null
        : asString(body.normalizedMerchant) || null;
    let categoryId: string | null = null;
    if (body.categoryId !== undefined && body.categoryId !== null) {
      if (typeof body.categoryId !== 'string' || !isUuid(body.categoryId)) {
        return reply.code(400).send({ error: 'Invalid categoryId' });
      }
      categoryId = body.categoryId;
    }
    if (merchant === null && categoryId === null) {
      return reply
        .code(400)
        .send({ error: 'A rule must set normalizedMerchant or categoryId (or both)' });
    }
    const enabled = body.enabled === undefined ? true : body.enabled !== false;
    let priority = 0;
    if (body.priority !== undefined) {
      const p = Number(body.priority);
      if (!Number.isInteger(p)) {
        return reply.code(400).send({ error: 'priority must be an integer' });
      }
      priority = p;
    }
    try {
      const r = await query(
        `INSERT INTO normalization_rules
           (tenant_id, pattern, normalized_merchant, category_id, enabled, priority)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [tenantId, pattern, merchant, categoryId, enabled, priority],
      );
      return reply.code(201).send({ rule: r.rows[0] });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply
          .code(409)
          .send({ error: 'A rule with this pattern already exists' });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/api/normalization-rules/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid rule id' });
      }
      const body = (req.body ?? {}) as {
        pattern?: unknown;
        normalizedMerchant?: unknown;
        categoryId?: unknown;
        enabled?: unknown;
        priority?: unknown;
      };
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.pattern !== undefined) {
        const p = asString(body.pattern);
        if (p.length < 2) {
          return reply.code(400).send({ error: 'pattern must be ≥ 2 characters' });
        }
        params.push(p);
        sets.push(`pattern = $${params.length}`);
      }
      if (body.normalizedMerchant !== undefined) {
        params.push(
          body.normalizedMerchant === null
            ? null
            : asString(body.normalizedMerchant) || null,
        );
        sets.push(`normalized_merchant = $${params.length}`);
      }
      if (body.categoryId !== undefined) {
        if (body.categoryId === null) {
          params.push(null);
        } else if (typeof body.categoryId === 'string' && isUuid(body.categoryId)) {
          params.push(body.categoryId);
        } else {
          return reply.code(400).send({ error: 'Invalid categoryId' });
        }
        sets.push(`category_id = $${params.length}`);
      }
      if (body.enabled !== undefined) {
        params.push(body.enabled !== false);
        sets.push(`enabled = $${params.length}`);
      }
      if (body.priority !== undefined) {
        const p = Number(body.priority);
        if (!Number.isInteger(p)) {
          return reply.code(400).send({ error: 'priority must be an integer' });
        }
        params.push(p);
        sets.push(`priority = $${params.length}`);
      }
      if (sets.length === 0) {
        return reply.code(400).send({ error: 'No updates' });
      }
      params.push(req.params.id);
      const idIdx = params.length;
      params.push(tenantId);
      const tenantIdx = params.length;
      const r = await query(
        `UPDATE normalization_rules SET ${sets.join(', ')}
          WHERE id = $${idIdx}
            AND tenant_id = $${tenantIdx}
       RETURNING ${COLUMNS}`,
        params,
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Rule not found' });
      }
      return { rule: r.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/normalization-rules/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid rule id' });
      }
      const r = await query(
        'DELETE FROM normalization_rules WHERE id = $1 AND tenant_id = $2',
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Rule not found' });
      }
      return reply.code(204).send();
    },
  );

  // Preview how many of THIS TENANT's transactions a pattern would
  // match. Used by the "Apply to similar?" prompt to show a count
  // before the user commits the rule.
  app.post('/api/normalization-rules/preview', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as { pattern?: unknown };
    const pattern = asString(body.pattern);
    if (pattern.length < 2) {
      return reply.code(400).send({ error: 'pattern must be ≥ 2 characters' });
    }
    const r = await query<{ total: number; manual: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE t.normalization_status = 'manual')::int AS manual
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.tenant_id = $1
          AND t.raw_description ILIKE '%' || $2 || '%'`,
      [tenantId, pattern],
    );
    return { pattern, total: r.rows[0]!.total, manual: r.rows[0]!.manual };
  });

  // Apply existing rules to matching transactions in THIS TENANT.
  // Skips rows already marked 'manual' unless includeManual=true.
  // Returns counts per rule. Also honors `enabled` — disabled rules
  // are simply not selected.
  app.post('/api/normalization-rules/apply', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as {
      ruleIds?: unknown;
      includeManual?: unknown;
    };
    const includeManual = body.includeManual === true;
    const ruleIds =
      Array.isArray(body.ruleIds) && body.ruleIds.every((x) => typeof x === 'string' && isUuid(x))
        ? (body.ruleIds as string[])
        : null;
    const rules = ruleIds
      ? await query<{
          id: string;
          pattern: string;
          normalized_merchant: string | null;
          category_id: string | null;
        }>(
          `SELECT id, pattern, normalized_merchant, category_id
             FROM normalization_rules
            WHERE tenant_id = $1
              AND enabled = true
              AND id = ANY($2::uuid[])
            ORDER BY priority ASC, created_at ASC`,
          [tenantId, ruleIds],
        )
      : await query<{
          id: string;
          pattern: string;
          normalized_merchant: string | null;
          category_id: string | null;
        }>(
          `SELECT id, pattern, normalized_merchant, category_id
             FROM normalization_rules
            WHERE tenant_id = $1
              AND enabled = true
            ORDER BY priority ASC, created_at ASC`,
          [tenantId],
        );

    const perRule: Array<{ id: string; updated: number }> = [];
    let totalUpdated = 0;
    for (const rule of rules.rows) {
      const sets: string[] = [];
      const params: unknown[] = [tenantId];
      if (rule.normalized_merchant !== null) {
        params.push(rule.normalized_merchant);
        sets.push(`normalized_merchant = $${params.length}`);
      }
      if (rule.category_id !== null) {
        params.push(rule.category_id);
        sets.push(`category_id = $${params.length}`);
      }
      if (sets.length === 0) continue;
      sets.push(`normalization_status = 'normalized'`);
      params.push(rule.pattern);
      const patternIdx = params.length;
      const whereStatus = includeManual
        ? ''
        : `AND t.normalization_status <> 'manual'`;
      const upd = await query(
        `UPDATE transactions AS t
            SET ${sets.join(', ')}
           FROM accounts AS a
          WHERE t.account_id = a.id
            AND a.tenant_id = $1
            AND t.raw_description ILIKE '%' || $${patternIdx} || '%'
            ${whereStatus}
       RETURNING t.id`,
        params,
      );
      const n = upd.rowCount ?? 0;
      totalUpdated += n;
      if (n > 0) {
        await query(
          `UPDATE normalization_rules
              SET match_count = match_count + $1, last_applied_at = now()
            WHERE id = $2 AND tenant_id = $3`,
          [n, rule.id, tenantId],
        );
      }
      perRule.push({ id: rule.id, updated: n });
    }
    return { totalUpdated, perRule };
  });
}
