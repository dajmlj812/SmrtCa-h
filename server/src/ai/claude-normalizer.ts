import Anthropic from '@anthropic-ai/sdk';
import { UNCATEGORIZED } from '../domain/categories.js';
import { AIProviderNotConfiguredError } from './errors.js';
import {
  buildNormalizerSystemPrompt,
  buildResponseSchema,
  encodeBatchLine,
  mergeWithBatch,
  type ParsedResponse,
} from './shared.js';
import type {
  NormalizationContext,
  NormalizationInput,
  NormalizationResult,
  TransactionNormalizer,
} from './types.js';

/**
 * Claude API provider. Uses the official Anthropic SDK with:
 *   - claude-haiku-4-5 (cheap and fast — the right tier for classification),
 *   - prompt caching on the stable system prompt (categories + rules + examples),
 *   - structured outputs via `output_config.format` for guaranteed-valid JSON,
 *   - in-prompt batching (one request per ~25 transactions),
 *   - typed-exception error handling per the Anthropic SDK.
 *
 * Requires `ANTHROPIC_API_KEY`. Enable with `AI_PROVIDER=claude`.
 */

const DEFAULT_MODEL = 'claude-haiku-4-5';
const BATCH_SIZE = 25;
const MAX_OUTPUT_TOKENS = 4000;

export interface ClaudeNormalizerOptions {
  apiKey: string;
  model?: string;
  /** Injected in tests so the SDK is not actually contacted. */
  client?: Anthropic;
}

export class ClaudeNormalizer implements TransactionNormalizer {
  readonly id = 'claude';
  readonly name = 'Claude API';

  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: ClaudeNormalizerOptions) {
    if (!opts.client && !opts.apiKey) {
      throw new AIProviderNotConfiguredError('claude', 'ANTHROPIC_API_KEY');
    }
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model || DEFAULT_MODEL;
  }

  async normalize(
    inputs: NormalizationInput[],
    ctx: NormalizationContext,
  ): Promise<NormalizationResult[]> {
    const allowed = ctx.categories.includes(UNCATEGORIZED)
      ? [...ctx.categories]
      : [...ctx.categories, UNCATEGORIZED];

    const results: NormalizationResult[] = [];
    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const batch = inputs.slice(i, i + BATCH_SIZE);
      results.push(...(await this.normalizeBatch(batch, allowed)));
    }
    return results;
  }

  private async normalizeBatch(
    batch: NormalizationInput[],
    allowed: string[],
  ): Promise<NormalizationResult[]> {
    const userText = batch.map(encodeBatchLine).join('\n');

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          {
            type: 'text',
            text: buildNormalizerSystemPrompt(allowed),
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: `Normalize the following ${batch.length} transactions and return one entry per transaction in the same order:\n\n${userText}`,
          },
        ],
        output_config: {
          format: {
            type: 'json_schema',
            schema: buildResponseSchema(allowed),
          },
        },
      } as Anthropic.MessageCreateParamsNonStreaming);

      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      );
      if (!textBlock) {
        throw new Error('Claude response contained no text block');
      }

      let parsed: ParsedResponse;
      try {
        parsed = JSON.parse(textBlock.text) as ParsedResponse;
      } catch (err) {
        throw new Error(
          `Claude response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return mergeWithBatch(batch, parsed, new Set(allowed));
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error(`Claude rate-limited (HTTP 429): ${err.message}`);
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(
          `Claude API error (HTTP ${err.status}): ${err.message}`,
        );
      }
      throw err;
    }
  }
}
