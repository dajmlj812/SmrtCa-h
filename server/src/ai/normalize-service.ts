import { pool } from '../db/pool.js';
import { UNCATEGORIZED } from '../domain/categories.js';
import { getNormalizer } from './factory.js';
import type {
  NormalizationInput,
  NormalizationResult,
} from './types.js';

export interface NormalizationSummary {
  /** The provider that ran, or 'none' if normalization is disabled. */
  provider: string;
  /** Pending transactions selected for normalization. */
  processed: number;
  /** Transactions successfully written. */
  normalized: number;
  /** Transactions whose normalization failed. */
  errors: number;
  /** Truncated list of error messages, when present. */
  errorDetails?: string[];
}

export interface NormalizePendingOptions {
  /**
   * Tenant scope — REQUIRED. Pre-0.14.4 the service walked every
   * tenant's transactions; the route now passes the caller's tenantId
   * so the SELECT joins through accounts and the UPDATE is gated.
   */
  tenantId: string;
  /** Restrict to one account; defaults to all caller-tenant accounts. */
  accountId?: string;
  /** Cap on transactions per call. Defaults to 500, max 2000. */
  limit?: number;
  /**
   * 0.17.5 — which rows to consider. Default 'pending' = legacy
   * behavior (only fresh transactions). 'all' includes
   * already-normalized rows so the user can re-run AI against
   * everything (e.g. after switching AI providers or to pick up
   * improved categorization). 'manual' rows are NEVER touched —
   * those are user choices.
   */
  mode?: 'pending' | 'all';
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/**
 * Normalize transactions whose `normalization_status` is still 'pending'.
 * 'manual' rows are left alone — they represent user choices.
 */
export async function normalizePending(
  opts: NormalizePendingOptions,
): Promise<NormalizationSummary> {
  if (!opts.tenantId) {
    throw new Error('normalizePending requires a tenantId');
  }
  const normalizer = getNormalizer();
  if (!normalizer) {
    return { provider: 'none', processed: 0, normalized: 0, errors: 0 };
  }

  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)),
    MAX_LIMIT,
  );

  const mode = opts.mode ?? 'pending';
  const pending = await fetchPendingTransactions(
    opts.tenantId,
    opts.accountId,
    limit,
    mode,
  );
  if (pending.length === 0) {
    return { provider: normalizer.id, processed: 0, normalized: 0, errors: 0 };
  }

  const categories = await fetchCategoryNames();

  let results: NormalizationResult[];
  try {
    results = await normalizer.normalize(pending, { categories });
  } catch (err) {
    return {
      provider: normalizer.id,
      processed: pending.length,
      normalized: 0,
      errors: pending.length,
      errorDetails: [err instanceof Error ? err.message : String(err)],
    };
  }

  const catByName = await fetchCategoryNameToIdMap();
  const uncategorizedId =
    catByName.get(UNCATEGORIZED.toLowerCase()) ?? null;

  let normalized = 0;
  let errors = 0;
  const errorDetails: string[] = [];

  for (const result of results) {
    const categoryId =
      catByName.get(result.category.toLowerCase()) ?? uncategorizedId;
    try {
      // 0.17.5 — in 'all' mode allow updating already-normalized
      // rows too. 'manual' is still off-limits (user choice). The
      // SELECT only returned rows matching the mode filter, so this
      // WHERE just guards against rows that turned 'manual' between
      // SELECT and UPDATE (race-safe).
      const updated = await pool.query(
        `UPDATE transactions
            SET normalized_merchant = $1,
                category_id = $2,
                normalization_status = 'normalized',
                normalization_note = $3,
                suggested_category_name = $4
          WHERE id = $5
            AND normalization_status <> 'manual'`,
        [
          result.merchant,
          categoryId,
          result.note,
          result.suggestedCategory,
          result.id,
        ],
      );
      if ((updated.rowCount ?? 0) > 0) normalized++;

      // Capture the AI's suggested-but-unknown category for user review.
      // Idempotent: the partial unique index on (lower(suggested_name))
      // WHERE status='pending' makes the second occurrence a no-op.
      if (result.suggestedCategory) {
        await pool.query(
          `INSERT INTO category_suggestions (suggested_name) VALUES ($1)
           ON CONFLICT DO NOTHING`,
          [result.suggestedCategory],
        );
      }
    } catch (err) {
      errors++;
      if (errorDetails.length < 10) {
        errorDetails.push(
          `${result.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    provider: normalizer.id,
    processed: pending.length,
    normalized,
    errors,
    ...(errorDetails.length > 0 ? { errorDetails } : {}),
  };
}

/**
 * 0.17.4 — count how many transactions are still pending
 * normalization for this tenant (optionally scoped to an account).
 * Powers the progress bar on the Transactions page: the client
 * fetches this once before starting, then loops `/api/normalize`
 * with a small `limit` until exhausted, updating progress between
 * batches against this denominator.
 */
export async function countPendingTransactions(
  tenantId: string,
  accountId?: string,
): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE a.tenant_id = $1
        AND t.normalization_status = 'pending'
        AND ($2::uuid IS NULL OR t.account_id = $2)`,
    [tenantId, accountId ?? null],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * 0.17.5 — count by status, in one round-trip. Powers the
 * "Re-normalize already-normalized too?" prompt: the client
 * needs to know both how many are pending and how many are
 * already done before deciding whether to ask.
 */
export async function countByNormalizationStatus(
  tenantId: string,
  accountId?: string,
): Promise<{ pending: number; normalized: number; manual: number }> {
  const r = await pool.query<{ status: string; n: string }>(
    `SELECT t.normalization_status AS status, COUNT(*)::text AS n
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE a.tenant_id = $1
        AND ($2::uuid IS NULL OR t.account_id = $2)
      GROUP BY t.normalization_status`,
    [tenantId, accountId ?? null],
  );
  const out = { pending: 0, normalized: 0, manual: 0 };
  for (const row of r.rows) {
    if (row.status === 'pending') out.pending = Number(row.n);
    else if (row.status === 'normalized') out.normalized = Number(row.n);
    else if (row.status === 'manual') out.manual = Number(row.n);
  }
  return out;
}

async function fetchPendingTransactions(
  tenantId: string,
  accountId: string | undefined,
  limit: number,
  mode: 'pending' | 'all' = 'pending',
): Promise<NormalizationInput[]> {
  const result = await pool.query<{
    id: string;
    raw_description: string;
    amount_cents: number;
    source_category: string | null;
    source_type: string | null;
  }>(
    `SELECT t.id, t.raw_description, t.amount_cents, t.source_category, t.source_type
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE a.tenant_id = $1
        AND (
          ($4::text = 'all'     AND t.normalization_status IN ('pending', 'normalized'))
          OR
          ($4::text = 'pending' AND t.normalization_status = 'pending')
        )
        AND ($2::uuid IS NULL OR t.account_id = $2)
      ORDER BY t.txn_date DESC, t.created_at DESC
      LIMIT $3`,
    [tenantId, accountId ?? null, limit, mode],
  );
  return result.rows.map((row) => ({
    id: row.id,
    rawDescription: row.raw_description,
    amountCents: row.amount_cents,
    sourceCategory: row.source_category,
    sourceType: row.source_type,
  }));
}

async function fetchCategoryNames(): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    'SELECT name FROM categories ORDER BY name',
  );
  return result.rows.map((r) => r.name);
}

async function fetchCategoryNameToIdMap(): Promise<Map<string, string>> {
  const result = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM categories',
  );
  return new Map(result.rows.map((r) => [r.name.toLowerCase(), r.id]));
}
