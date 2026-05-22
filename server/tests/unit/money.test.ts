import { describe, it, expect } from 'vitest';
import {
  parseAmountToCents,
  tryParseAmountToCents,
  centsToDecimalString,
} from '../../src/domain/money.js';

describe('parseAmountToCents', () => {
  it('parses plain decimal amounts', () => {
    expect(parseAmountToCents('500.00')).toBe(50000);
    expect(parseAmountToCents('-4.50')).toBe(-450);
    expect(parseAmountToCents('-87.32')).toBe(-8732);
    expect(parseAmountToCents('0.00')).toBe(0);
  });

  it('handles thousands separators and currency symbols', () => {
    expect(parseAmountToCents('1,419.00')).toBe(141900);
    expect(parseAmountToCents('$2,466.57')).toBe(246657);
  });

  it('treats parentheses as negative', () => {
    expect(parseAmountToCents('(12.34)')).toBe(-1234);
  });

  it('handles whole numbers and signs', () => {
    expect(parseAmountToCents('12')).toBe(1200);
    expect(parseAmountToCents('+5.00')).toBe(500);
    expect(parseAmountToCents('-0.01')).toBe(-1);
  });

  it('trims surrounding whitespace', () => {
    expect(parseAmountToCents('  -9.99  ')).toBe(-999);
  });

  it('accepts numeric input', () => {
    expect(parseAmountToCents(14.19)).toBe(1419);
    expect(parseAmountToCents(-4.5)).toBe(-450);
  });

  it('throws on empty or non-numeric input', () => {
    expect(() => parseAmountToCents('')).toThrow();
    expect(() => parseAmountToCents('   ')).toThrow();
    expect(() => parseAmountToCents('abc')).toThrow();
    expect(() => parseAmountToCents('not-a-number')).toThrow();
    expect(() => parseAmountToCents('.')).toThrow();
  });

  it('never loses precision (no floating-point drift)', () => {
    // 0.1 + 0.2 famously != 0.3 in float; cents must be exact.
    expect(parseAmountToCents('0.10') + parseAmountToCents('0.20')).toBe(
      parseAmountToCents('0.30'),
    );
  });
});

describe('tryParseAmountToCents', () => {
  it('returns null instead of throwing', () => {
    expect(tryParseAmountToCents('')).toBeNull();
    expect(tryParseAmountToCents(' ')).toBeNull();
    expect(tryParseAmountToCents(null)).toBeNull();
    expect(tryParseAmountToCents(undefined)).toBeNull();
    expect(tryParseAmountToCents('abc')).toBeNull();
  });

  it('still parses valid amounts', () => {
    expect(tryParseAmountToCents('100.00')).toBe(10000);
  });
});

describe('centsToDecimalString', () => {
  it('formats cents back to a decimal string', () => {
    expect(centsToDecimalString(141900)).toBe('1419.00');
    expect(centsToDecimalString(-999)).toBe('-9.99');
    expect(centsToDecimalString(0)).toBe('0.00');
    expect(centsToDecimalString(-1)).toBe('-0.01');
    expect(centsToDecimalString(5)).toBe('0.05');
  });
});
