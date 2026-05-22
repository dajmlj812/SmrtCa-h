/**
 * The pluggable transaction-normalization layer. Three providers implement
 * the same interface (`rules`, `claude`, `ollama`), so the rest of the system
 * never knows or cares which one is configured.
 */

export interface NormalizationInput {
  /** Echoed back in the result so callers can map results to inputs. */
  id: string;
  rawDescription: string;
  amountCents: number;
  sourceCategory: string | null;
  sourceType: string | null;
}

export interface NormalizationResult {
  /** The id of the corresponding NormalizationInput. */
  id: string;
  /** Cleaned merchant name. */
  merchant: string;
  /** Exactly one of `ctx.categories` (provider must fall back to 'Uncategorized'). */
  category: string;
  /**
   * When the provider's chosen category was *not* in the allowed list, the
   * raw suggestion is captured here for the user to validate. `category` in
   * that case is coerced to 'Uncategorized'. Null otherwise.
   */
  suggestedCategory: string | null;
  /** Provider's self-rated confidence, 0..1. */
  confidence: number;
  /** Optional free-form note (reasoning, warning, etc.). */
  note: string | null;
}

export interface NormalizationContext {
  /** The closed set of category names the normalizer must pick from. */
  categories: readonly string[];
}

export interface TransactionNormalizer {
  /** Stable provider id used in logs and the `normalization_runs` audit. */
  readonly id: string;
  /** Human-readable provider name. */
  readonly name: string;
  /**
   * Normalize a batch. Implementations must return one result per input, in
   * the same order — but callers should still map by `id` for safety.
   */
  normalize(
    inputs: NormalizationInput[],
    ctx: NormalizationContext,
  ): Promise<NormalizationResult[]>;
}
