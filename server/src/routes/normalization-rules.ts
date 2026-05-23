import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';

const COLUMNS = `id, pattern, normalized_merchant, category_id, source,
  match_count, last_applied_at, created_at`;

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Learned normalization rules. Each row is a substring pattern that, when
 * present in a transaction's raw_description, applies a normalized
 * merchant name and/or category. Rules are captured from manual edits
 * via the "Apply to similar?" prompt in the web UI and run automatically
 * on every import.
 *
 * `normalization_status='manual'` rows are skipped by the auto-apply pass
 * so a user's explicit override never gets overwritten. `POST /apply`
 * with `force: true` (or `includeManual: true`) overrides that.
 */
export async function normalizationRuleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/normalization-rules', async () => {
    const r = await query(`SELECT ${COLUMNS} FROM normalization_rules ORDER BY created_at DESC`);
    return { rules: r.rows };
  });

  app.post('/api/normalization-rules', async (req, reply) => {
    const body = (req.body ?? {}) as {
      pattern?: unknown;
      normalizedMerchant?: unknown;
      categoryId?: unknown;
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
    try {
      const r = await query(
        `INSERT INTO normalization_rules (pattern, normalized_merchant, category_id)
         VALUES ($1, $2, $3)
         RETURNING ${COLUMNS}`,
        [pattern, merchant, categoryId],
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
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid rule id' });
      }
      const body = (req.body ?? {}) as {
        pattern?: unknown;
        normalizedMerchant?: unknown;
        categoryId?: unknown;
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
      if (sets.length === 0) {
        return reply.code(400).send({ error: 'No updates' });
      }
      params.push(req.params.id);
      const r = await query(
        `UPDATE normalization_rules SET ${sets.join(', ')}
          WHERE id = $${params.length}
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
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid rule id' });
      }
      const r = await query('DELETE FROM normalization_rules WHERE id = $1', [
        req.params.id,
      ]);
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Rule not found' });
      }
      return reply.code(204).send();
    },
  );

  // Preview how many transactions a pattern would match. Used by the
  // "Apply to similar?" prompt to show a count before the user commits.
  app.post('/api/normalization-rules/preview', async (req, reply) => {
    const body = (req.body ?? {}) as { pattern?: unknown };
    const pattern = asString(body.pattern);
    if (pattern.length < 2) {
      return reply.code(400).send({ error: 'pattern must be ≥ 2 characters' });
    }
    const r = await query<{ total: number; manual: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE normalization_status = 'manual')::int AS manual
         FROM transactions
        WHERE raw_description ILIKE '%' || $1 || '%'`,
      [pattern],
    );
    return { pattern, total: r.rows[0]!.total, manual: r.rows[0]!.manual };
  });

  // Apply existing rules to matching transactions. Skips rows already
  // marked 'manual' unless includeManual=true. Returns counts per rule.
  app.post('/api/normalization-rules/apply', async (req) => {
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
             FROM normalization_rules WHERE id = ANY($1::uuid[])`,
          [ruleIds],
        )
      : await query<{
          id: string;
          pattern: string;
          normalized_merchant: string | null;
          category_id: string | null;
        }>(`SELECT id, pattern, normalized_merchant, category_id FROM normalization_rules`);

    const perRule: Array<{ id: string; updated: number }> = [];
    let totalUpdated = 0;
    for (const rule of rules.rows) {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (rule.normalized_merchant !== null) {
        params.push(rule.normalized_merchant);
        sets.push(`normalized_merchant = $${params.length}`);
      }
      if (rule.category_id !== null) {
        params.push(rule.category_id);
        sets.push(`category_id = $${params.length}`);
      }
      if (sets.length === 0) continue;
      // Rule application is itself an automatic-but-explicit action; mark
      // touched rows 'normalized' (not 'manual') so future rule edits can
      // re-touch them. Rows where the user explicitly hand-edited are
      // protected unless includeManual is set.
      sets.push(`normalization_status = 'normalized'`);
      params.push(rule.pattern);
      const patternIdx = params.length;
      const whereStatus = includeManual
        ? ''
        : `AND normalization_status <> 'manual'`;
      const upd = await query(
        `UPDATE transactions
            SET ${sets.join(', ')}
          WHERE raw_description ILIKE '%' || $${patternIdx} || '%'
            ${whereStatus}
       RETURNING id`,
        params,
      );
      const n = upd.rowCount ?? 0;
      totalUpdated += n;
      if (n > 0) {
        await query(
          `UPDATE normalization_rules
              SET match_count = match_count + $1, last_applied_at = now()
            WHERE id = $2`,
          [n, rule.id],
        );
      }
      perRule.push({ id: rule.id, updated: n });
    }
    return { totalUpdated, perRule };
  });
}
