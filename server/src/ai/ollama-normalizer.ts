import { UNCATEGORIZED } from '../domain/categories.js';
import {
  buildNormalizerSystemPrompt,
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
 * Ollama provider — calls a local model via the Ollama HTTP API. Fully
 * private; transaction text never leaves your machine. Slower and less
 * accurate than Claude on the same workload, but the privacy-preserving
 * default for users who do not want any cloud round-trip.
 *
 * Requires Ollama running with the configured model pulled
 * (`ollama pull llama3.1`). Enable with `AI_PROVIDER=ollama`.
 */

const BATCH_SIZE = 25;

export interface OllamaNormalizerOptions {
  baseUrl: string;
  model: string;
  /** Injected in tests so the real network is never contacted. */
  fetchImpl?: typeof fetch;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

export class OllamaNormalizer implements TransactionNormalizer {
  readonly id = 'ollama';
  readonly name = 'Ollama (local)';

  private readonly endpoint: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaNormalizerOptions) {
    this.endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/api/chat`;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: buildNormalizerSystemPrompt(allowed) },
        {
          role: 'user',
          content: `Normalize the following ${batch.length} transactions and return one entry per transaction in the same order:\n\n${userText}`,
        },
      ],
      // Ollama's "json" format constrains output to valid JSON. The model
      // still has to match the schema by prompting (the prompt describes it).
      format: 'json',
      stream: false,
    };

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `Ollama request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama returned HTTP ${res.status}: ${text || res.statusText}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }
    const content = data.message?.content;
    if (!content) {
      throw new Error('Ollama response contained no message content');
    }

    let parsed: ParsedResponse | null = null;
    try {
      parsed = JSON.parse(content) as ParsedResponse;
    } catch {
      // Best-effort: try to extract the JSON object from a noisy response.
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]) as ParsedResponse;
        } catch {
          parsed = null;
        }
      }
    }

    return mergeWithBatch(batch, parsed, new Set(allowed));
  }
}
