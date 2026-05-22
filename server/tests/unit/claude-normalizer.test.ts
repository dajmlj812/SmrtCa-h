import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeNormalizer } from '../../src/ai/claude-normalizer.js';
import { DEFAULT_CATEGORIES } from '../../src/domain/categories.js';

interface MessageBlock {
  type: 'text';
  text: string;
}

function fakeClient(text: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text }] as MessageBlock[],
      })),
    },
  } as unknown as Anthropic;
}

describe('ClaudeNormalizer', () => {
  it('sends a request with cached system, structured output and the configured model', async () => {
    const client = fakeClient(
      JSON.stringify({
        results: [
          {
            id: 't1',
            merchant: 'Netflix',
            category: 'Subscriptions',
            confidence: 0.95,
            note: '',
          },
        ],
      }),
    );
    const normalizer = new ClaudeNormalizer({ apiKey: 'k', client });

    await normalizer.normalize(
      [
        {
          id: 't1',
          rawDescription: 'NETFLIX.COM',
          amountCents: -2847,
          sourceCategory: 'Entertainment',
          sourceType: null,
        },
      ],
      { categories: DEFAULT_CATEGORIES },
    );

    const createMock = (client.messages as unknown as { create: ReturnType<typeof vi.fn> }).create;
    expect(createMock).toHaveBeenCalledOnce();
    const arg = createMock.mock.calls[0]![0] as {
      model: string;
      system: Array<{ type: string; text: string; cache_control: { type: string } }>;
      output_config: { format: { type: string; schema: unknown } };
    };
    expect(arg.model).toBe('claude-haiku-4-5');
    expect(arg.system[0]!.cache_control.type).toBe('ephemeral');
    expect(arg.system[0]!.text).toContain('Allowed categories');
    expect(arg.output_config.format.type).toBe('json_schema');
  });

  it('parses the response and returns one entry per input', async () => {
    const client = fakeClient(
      JSON.stringify({
        results: [
          {
            id: 't1',
            merchant: 'Netflix',
            category: 'Subscriptions',
            confidence: 0.95,
            note: '',
          },
          {
            id: 't2',
            merchant: 'IRS',
            category: 'Taxes',
            confidence: 0.99,
            note: '',
          },
        ],
      }),
    );
    const normalizer = new ClaudeNormalizer({ apiKey: 'k', client });
    const results = await normalizer.normalize(
      [
        {
          id: 't1',
          rawDescription: 'NETFLIX.COM',
          amountCents: -2847,
          sourceCategory: null,
          sourceType: null,
        },
        {
          id: 't2',
          rawDescription: 'IRS USATAXPYMT',
          amountCents: -1000,
          sourceCategory: null,
          sourceType: null,
        },
      ],
      { categories: DEFAULT_CATEGORIES },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.merchant).toBe('Netflix');
    expect(results[1]!.category).toBe('Taxes');
  });

  it('falls back to Uncategorized when the model omits a row', async () => {
    const client = fakeClient(JSON.stringify({ results: [] }));
    const normalizer = new ClaudeNormalizer({ apiKey: 'k', client });
    const results = await normalizer.normalize(
      [
        {
          id: 't1',
          rawDescription: 'X',
          amountCents: -1,
          sourceCategory: null,
          sourceType: null,
        },
      ],
      { categories: DEFAULT_CATEGORIES },
    );
    expect(results[0]!.category).toBe('Uncategorized');
    expect(results[0]!.note).toBe('Missing from model response');
  });

  it('rethrows a clearer error when the SDK fails', async () => {
    const client = {
      messages: { create: vi.fn(async () => Promise.reject(new Error('boom'))) },
    } as unknown as Anthropic;
    const normalizer = new ClaudeNormalizer({ apiKey: 'k', client });
    await expect(
      normalizer.normalize(
        [
          {
            id: 't1',
            rawDescription: 'X',
            amountCents: -1,
            sourceCategory: null,
            sourceType: null,
          },
        ],
        { categories: DEFAULT_CATEGORIES },
      ),
    ).rejects.toThrow(/boom/);
  });
});
