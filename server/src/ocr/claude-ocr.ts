import Anthropic from '@anthropic-ai/sdk';
import {
  OCR_SYSTEM_PROMPT,
  buildOcrSchema,
  sanitizeOcrResult,
} from './prompt.js';
import type { OcrInput, OcrProvider, OcrResult } from './types.js';

/**
 * Claude API OCR provider — uses the Anthropic SDK with image / document
 * content blocks and structured outputs to extract receipt details.
 *
 * Requires `ANTHROPIC_API_KEY`. Enabled when `AI_PROVIDER=claude`.
 */

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_OUTPUT_TOKENS = 1024;

const IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export interface ClaudeOcrOptions {
  apiKey: string;
  model?: string;
  /** Injected in tests so the real network is never contacted. */
  client?: Anthropic;
}

export class ClaudeOcrProvider implements OcrProvider {
  readonly id = 'claude';
  readonly name = 'Claude API (vision)';

  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: ClaudeOcrOptions) {
    if (!opts.client && !opts.apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is required when AI_PROVIDER=claude',
      );
    }
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model || DEFAULT_MODEL;
  }

  async extract(input: OcrInput): Promise<OcrResult> {
    const mediaBlock = this.buildMediaBlock(input);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: OCR_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              mediaBlock,
              {
                type: 'text',
                text: 'Extract the receipt details from this document.',
              },
            ],
          },
        ],
        output_config: {
          format: {
            type: 'json_schema',
            schema: buildOcrSchema(),
          },
        },
      } as Anthropic.MessageCreateParamsNonStreaming);

      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      );
      if (!textBlock) {
        throw new Error('Claude OCR response contained no text block');
      }

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(textBlock.text) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `Claude OCR response was not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      return sanitizeOcrResult(raw);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error(`Claude OCR rate-limited (HTTP 429): ${err.message}`);
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(
          `Claude OCR error (HTTP ${err.status}): ${err.message}`,
        );
      }
      throw err;
    }
  }

  private buildMediaBlock(
    input: OcrInput,
  ): Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam {
    const base64 = input.buffer.toString('base64');

    if (input.mimeType === 'application/pdf') {
      return {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: base64,
        },
      };
    }

    if (!IMAGE_MEDIA_TYPES.has(input.mimeType)) {
      throw new Error(
        `Claude OCR cannot process MIME type "${input.mimeType}". ` +
          'Supported: image/jpeg, image/png, image/webp, application/pdf.',
      );
    }

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: input.mimeType as
          | 'image/jpeg'
          | 'image/png'
          | 'image/webp'
          | 'image/gif',
        data: base64,
      },
    };
  }
}
