import { describe, it, expect, vi } from 'vitest';
import { OllamaNormalizer } from '../../src/ai/ollama-normalizer.js';
import { DEFAULT_CATEGORIES } from '../../src/domain/categories.js';

function fakeFetch(content: string, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ message: { content } }), { status }),
  ) as unknown as typeof fetch;
}

describe('OllamaNormalizer', () => {
  it('posts to /api/chat with the configured model and JSON format', async () => {
    const fetchImpl = fakeFetch(
      JSON.stringify({
        results: [
          {
            id: 't1',
            merchant: 'Netflix',
            category: 'Subscriptions',
            confidence: 0.9,
            note: '',
          },
        ],
      }),
    );
    const normalizer = new OllamaNormalizer({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      fetchImpl,
    });

    await normalizer.normalize(
      [
        {
          id: 't1',
          rawDescription: 'NETFLIX',
          amountCents: -2847,
          sourceCategory: null,
          sourceType: null,
        },
      ],
      { categories: DEFAULT_CATEGORIES },
    );

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse((init as { body: string }).body) as {
      model: string;
      format: string;
      messages: Array<{ role: string }>;
    };
    expect(body.model).toBe('llama3.1');
    expect(body.format).toBe('json');
    expect(body.messages[0]!.role).toBe('system');
  });

  it('parses a clean JSON response', async () => {
    const fetchImpl = fakeFetch(
      JSON.stringify({
        results: [
          {
            id: 't1',
            merchant: 'Netflix',
            category: 'Subscriptions',
            confidence: 0.9,
            note: '',
          },
        ],
      }),
    );
    const normalizer = new OllamaNormalizer({
      baseUrl: 'http://localhost:11434/',
      model: 'llama3.1',
      fetchImpl,
    });
    const results = await normalizer.normalize(
      [
        {
          id: 't1',
          rawDescription: 'NETFLIX',
          amountCents: -2847,
          sourceCategory: null,
          sourceType: null,
        },
      ],
      { categories: DEFAULT_CATEGORIES },
    );
    expect(results[0]!.merchant).toBe('Netflix');
    expect(results[0]!.category).toBe('Subscriptions');
  });

  it('extracts the JSON object from a noisy response', async () => {
    const fetchImpl = fakeFetch(
      'Sure, here you go:\n{"results":[{"id":"t1","merchant":"X","category":"Uncategorized","confidence":0.5,"note":""}]}\nthanks',
    );
    const normalizer = new OllamaNormalizer({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      fetchImpl,
    });
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
    expect(results[0]!.merchant).toBe('X');
  });

  it('throws a useful error on HTTP failure', async () => {
    const fetchImpl = fakeFetch('server down', 500);
    const normalizer = new OllamaNormalizer({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      fetchImpl,
    });
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
    ).rejects.toThrow(/HTTP 500/);
  });
});
