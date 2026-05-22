import { describe, it, expect } from 'vitest';
import {
  buildResponseSchema,
  encodeBatchLine,
  mergeWithBatch,
} from '../../src/ai/shared.js';
import { DEFAULT_CATEGORIES } from '../../src/domain/categories.js';

const ALLOWED = new Set<string>(DEFAULT_CATEGORIES);

describe('encodeBatchLine', () => {
  it('serializes a transaction as a one-line JSON-ish row', () => {
    const line = encodeBatchLine(
      {
        id: 'abc-1',
        rawDescription: 'NETFLIX.COM',
        amountCents: -2847,
        sourceCategory: 'Entertainment',
        sourceType: null,
      },
      0,
    );
    expect(line).toContain('id="abc-1"');
    expect(line).toContain('amount_cents=-2847');
    expect(line).toContain('source_category="Entertainment"');
    expect(line).toContain('raw="NETFLIX.COM"');
  });
});

describe('buildResponseSchema', () => {
  it('produces a schema whose category enum matches the allowed list', () => {
    const schema = buildResponseSchema(['Income', 'Uncategorized']) as {
      properties: {
        results: {
          items: {
            properties: { category: { enum: string[] } };
          };
        };
      };
    };
    expect(schema.properties.results.items.properties.category.enum).toEqual([
      'Income',
      'Uncategorized',
    ]);
  });
});

describe('mergeWithBatch', () => {
  const batch = [
    {
      id: 't1',
      rawDescription: 'COFFEE SHOP',
      amountCents: -500,
      sourceCategory: null,
      sourceType: null,
    },
    {
      id: 't2',
      rawDescription: 'NETFLIX',
      amountCents: -2000,
      sourceCategory: null,
      sourceType: null,
    },
  ];

  it('aligns results with inputs by id', () => {
    const merged = mergeWithBatch(
      batch,
      {
        results: [
          {
            id: 't1',
            merchant: 'Coffee Shop',
            category: 'Dining & Restaurants',
            confidence: 0.9,
            note: '',
          },
          {
            id: 't2',
            merchant: 'Netflix',
            category: 'Subscriptions',
            confidence: 0.95,
            note: '',
          },
        ],
      },
      ALLOWED,
    );
    expect(merged.map((m) => m.id)).toEqual(['t1', 't2']);
    expect(merged[0]!.merchant).toBe('Coffee Shop');
    expect(merged[1]!.category).toBe('Subscriptions');
  });

  it('fills in a safe default when a result is missing', () => {
    const merged = mergeWithBatch(batch, { results: [] }, ALLOWED);
    expect(merged[0]!.category).toBe('Uncategorized');
    expect(merged[0]!.note).toBe('Missing from model response');
  });

  it('clamps confidence and captures an unknown category as a suggestion', () => {
    const merged = mergeWithBatch(
      [batch[0]!],
      {
        results: [
          {
            id: 't1',
            merchant: 'X',
            category: 'BogusCategory',
            confidence: 3,
            note: '',
          },
        ],
      },
      ALLOWED,
    );
    expect(merged[0]!.category).toBe('Uncategorized');
    expect(merged[0]!.confidence).toBe(1);
    // The AI's unknown choice is captured for the user to validate.
    expect(merged[0]!.suggestedCategory).toBe('BogusCategory');
  });

  it('does not surface a suggestion when the AI explicitly said Uncategorized', () => {
    const merged = mergeWithBatch(
      [batch[0]!],
      {
        results: [
          {
            id: 't1',
            merchant: 'Coffee',
            category: 'Uncategorized',
            confidence: 0.4,
            note: 'No good fit',
          },
        ],
      },
      ALLOWED,
    );
    expect(merged[0]!.category).toBe('Uncategorized');
    expect(merged[0]!.suggestedCategory).toBeNull();
  });

  it('preserves a non-empty note and nulls an empty one', () => {
    const merged = mergeWithBatch(
      [batch[0]!],
      {
        results: [
          {
            id: 't1',
            merchant: 'Coffee Shop',
            category: 'Dining & Restaurants',
            confidence: 0.9,
            note: '   ',
          },
        ],
      },
      ALLOWED,
    );
    expect(merged[0]!.note).toBeNull();
  });

  it('handles a null parsed response gracefully', () => {
    const merged = mergeWithBatch(batch, null, ALLOWED);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.category).toBe('Uncategorized');
  });
});
