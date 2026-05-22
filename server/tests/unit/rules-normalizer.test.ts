import { describe, it, expect } from 'vitest';
import {
  RulesNormalizer,
  cleanMerchant,
  pickCategory,
} from '../../src/ai/rules-normalizer.js';
import { DEFAULT_CATEGORIES } from '../../src/domain/categories.js';

const ALLOWED = new Set<string>(DEFAULT_CATEGORIES);

describe('cleanMerchant', () => {
  it('strips POS DEBIT prefix and trailing noise from a Chase bank row', () => {
    expect(
      cleanMerchant(
        'POS DEBIT TMOBILE*POSTPAID PDA 800-937-8997 WA',
      ),
    ).toBe('T-Mobile');
  });

  it('strips PP* PayPal prefix', () => {
    expect(cleanMerchant('PP*GOOGLE CEDAR')).toMatch(/Google/);
  });

  it('strips store numbers and trailing state codes', () => {
    expect(cleanMerchant('WALGREENS STORE 3805 8 KENOSHA WI')).toMatch(
      /Walgreens/,
    );
  });

  it('drops trailing corporate suffixes', () => {
    expect(cleanMerchant('POS DEBIT ONSTAR, LLC 888-4667827 MI 0408')).toMatch(
      /Onstar/i,
    );
  });

  it('keeps known acronyms uppercased', () => {
    expect(cleanMerchant('IRS USATAXPYMT 222650344221142')).toContain('IRS');
  });

  it('dedupes consecutive duplicate tokens', () => {
    expect(cleanMerchant('POS DEBIT NETFLIX.COM NETFLIX.COM CA')).toBe(
      'Netflix',
    );
  });
});

describe('pickCategory', () => {
  it('maps a Chase source category to ours', () => {
    expect(pickCategory('anything', 'Food & Drink', ALLOWED)).toEqual({
      category: 'Dining & Restaurants',
      confidence: 0.8,
    });
  });

  it('picks a category by keyword when no source hint is given', () => {
    expect(pickCategory('KWIK TRIP #1091 PLEASANT PRAI WI', null, ALLOWED))
      .toEqual({ category: 'Gas & Fuel', confidence: 0.7 });
  });

  it('prefers Subscriptions over Travel for UBER *ONE', () => {
    expect(pickCategory('UBER *ONE MEMBERSHIP', 'Travel', ALLOWED)).toEqual({
      category: 'Subscriptions',
      confidence: 0.85,
    });
  });

  it('falls back to Uncategorized when nothing matches', () => {
    expect(pickCategory('XYZ-RANDOM-CHARGE-12345', null, ALLOWED)).toEqual({
      category: 'Uncategorized',
      confidence: 0.2,
    });
  });
});

describe('RulesNormalizer.normalize', () => {
  it('produces one result per input in order', async () => {
    const normalizer = new RulesNormalizer();
    const results = await normalizer.normalize(
      [
        {
          id: '1',
          rawDescription: 'POS DEBIT TMOBILE*POSTPAID PDA 800-937-8997 WA',
          amountCents: -3314,
          sourceCategory: null,
          sourceType: null,
        },
        {
          id: '2',
          rawDescription: 'IRS USATAXPYMT 222650344221142',
          amountCents: -1000000,
          sourceCategory: null,
          sourceType: null,
        },
      ],
      { categories: DEFAULT_CATEGORIES },
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('1');
    expect(results[0]!.merchant).toBe('T-Mobile');
    expect(results[0]!.category).toBe('Bills & Utilities');
    expect(results[1]!.id).toBe('2');
    expect(results[1]!.category).toBe('Taxes');
  });
});
