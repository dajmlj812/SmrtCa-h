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
  /** Restrict to one account; defaults to all accounts. */
  accountId?: string;
  /** Cap on transactions per call. Defaults to 500, max 2000. */
  limit?: number;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/**
 * Normalize transactions whose `normalization_status` is still 'pending'.
 * 'manual' rows are left alone — they represent user choices.
 */
export async function normalizePending(
  opts: NormalizePendingOptions = {},
): Promise<NormalizationSummary> {
  const normalizer = getNormalizer();
  if (!normalizer) {
    return { provider: 'none', processed: 0, normalized: 0, errors: 0 };
  }

  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)),
    MAX_LIMIT,
  );

  const pending = await fetchPendingTransactions(opts.accountId, limit);
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
      const updated = await pool.query(
        `UPDATE transactions
            SET normalized_merchant = $1,
                category_id = $2,
                normalization_status = 'normalized',
                normalization_note = $3,
                suggested_category_name = $4
          WHERE id = $5
            AND normalization_status = 'pending'`,
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

async function fetchPendingTransactions(
  accountId: string | undefined,
  limit: number,
): Promise<NormalizationInput[]> {
  const result = await pool.query<{
    id: string;
    raw_description: string;
    amount_cents: number;
    source_category: string | null;
    source_type: string | null;
  }>(
    `SELECT id, raw_description, amount_cents, source_category, source_type
       FROM transactions
      WHERE normalization_status = 'pending'
        AND ($1::uuid IS NULL OR account_id = $1)
      ORDER BY txn_date DESC, created_at DESC
      LIMIT $2`,
    [accountId ?? null, limit],
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
