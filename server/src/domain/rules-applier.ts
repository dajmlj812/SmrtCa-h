import { pool } from '../db/pool.js';

/**
 * Backlog (0.13.6) — non-AI rules engine completion.
 *
 * Applies a tenant's enabled `normalization_rules` to a set of
 * transactions, in ASC priority order (so the highest-priority rule
 * writes LAST and wins on overlapping matches). Rows whose
 * `normalization_status = 'manual'` are protected — a user's explicit
 * hand-edit is never overwritten by an automatic pass.
 *
 * Called from two places:
 *
 *   1. `persistBatch()` (server/src/import/importer.ts) — every
 *      successful import runs this over the freshly-inserted ids, so
 *      newly-imported transactions are categorized without the user
 *      clicking "Apply rules" or running the AI normalizer.
 *
 *   2. `POST /api/normalization-rules/apply` — manual re-application
 *      over the tenant's existing data (e.g., after editing a rule's
 *      category target). That route uses its own SQL because it can
 *      also include manual rows via `includeManual: true` — auto-
 *      apply on import never overrides manual rows.
 *
 * Best-effort: the importer caller wraps this in try/catch so a SQL
 * failure during the apply pass cannot break the import itself.
 */

export interface RulesApplyResult {
  /** Distinct transactions that were touched by at least one rule. */
  updated: number;
  /** Number of enabled rules considered. */
  rulesConsidered: number;
}

interface RuleRow {
  id: string;
  pattern: string;
  normalized_merchant: string | null;
  category_id: string | null;
}

/**
 * Apply the tenant's enabled rules to the listed transaction ids.
 * No-op when either input is empty.
 *
 * Always skips rows where `normalization_status = 'manual'`. Updates
 * each rule's `match_count` + `last_applied_at` so the rules-list UI
 * can show "this rule has matched 412 transactions, last hit yesterday."
 */
export async function applyRulesToTransactions(
  tenantId: string,
  transactionIds: string[],
): Promise<RulesApplyResult> {
  if (!tenantId || transactionIds.length === 0) {
    return { updated: 0, rulesConsidered: 0 };
  }

  // Load this tenant's enabled rules, lowest priority first so the
  // highest-priority rule's UPDATE runs last and wins on overlapping
  // matches. Within the same priority, deterministic order by
  // created_at — older rules apply first.
  const rules = await pool.query<RuleRow>(
    `SELECT id, pattern, normalized_merchant, category_id
       FROM normalization_rules
      WHERE tenant_id = $1
        AND enabled = true
      ORDER BY priority ASC, created_at ASC`,
    [tenantId],
  );

  if (rules.rows.length === 0) {
    return { updated: 0, rulesConsidered: 0 };
  }

  const touched = new Set<string>();
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
    // Same mark-as-normalized convention the manual apply route uses,
    // so future rule edits can re-touch these rows.
    sets.push(`normalization_status = 'normalized'`);
    params.push(rule.pattern);
    const patternIdx = params.length;
    params.push(transactionIds);
    const idsIdx = params.length;
    const upd = await pool.query<{ id: string }>(
      `UPDATE transactions
          SET ${sets.join(', ')}
        WHERE id = ANY($${idsIdx}::uuid[])
          AND raw_description ILIKE '%' || $${patternIdx} || '%'
          AND normalization_status <> 'manual'
     RETURNING id`,
      params,
    );
    const n = upd.rowCount ?? 0;
    if (n > 0) {
      for (const row of upd.rows) touched.add(row.id);
      await pool.query(
        `UPDATE normalization_rules
            SET match_count = match_count + $1, last_applied_at = now()
          WHERE id = $2`,
        [n, rule.id],
      );
    }
  }

  return { updated: touched.size, rulesConsidered: rules.rows.length };
}
