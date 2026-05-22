import { describe, it, expect } from 'vitest';
import { sanitizeOcrResult } from '../../src/ocr/prompt.js';

describe('sanitizeOcrResult', () => {
  it('passes a well-formed payload through', () => {
    const result = sanitizeOcrResult({
      amountCents: 1234,
      date: '2026-05-14',
      merchant: 'Starbucks',
      confidence: 0.9,
      note: '',
    });
    expect(result).toEqual({
      amountCents: 1234,
      date: '2026-05-14',
      merchant: 'Starbucks',
      confidence: 0.9,
      note: null,
    });
  });

  it('rounds a fractional amount and rejects negative / non-numeric', () => {
    expect(sanitizeOcrResult({ amountCents: 12.7 }).amountCents).toBe(13);
    expect(sanitizeOcrResult({ amountCents: -5 }).amountCents).toBeNull();
    expect(sanitizeOcrResult({ amountCents: 'twelve' }).amountCents).toBeNull();
    expect(sanitizeOcrResult({ amountCents: NaN }).amountCents).toBeNull();
  });

  it('rejects malformed dates and impossible month/day values', () => {
    expect(sanitizeOcrResult({ date: '2026-05-14' }).date).toBe('2026-05-14');
    expect(sanitizeOcrResult({ date: '5/14/2026' }).date).toBeNull();
    expect(sanitizeOcrResult({ date: '2026-13-01' }).date).toBeNull();
    expect(sanitizeOcrResult({ date: '2026-05-99' }).date).toBeNull();
    expect(sanitizeOcrResult({ date: null }).date).toBeNull();
  });

  it('zero-pads single-digit month and day on the way out', () => {
    expect(sanitizeOcrResult({ date: '2026-5-3' }).date).toBe('2026-05-03');
  });

  it('trims and caps the merchant; nulls when empty', () => {
    expect(sanitizeOcrResult({ merchant: '  Starbucks  ' }).merchant).toBe(
      'Starbucks',
    );
    expect(sanitizeOcrResult({ merchant: '' }).merchant).toBeNull();
    expect(
      sanitizeOcrResult({ merchant: 'A'.repeat(500) }).merchant!.length,
    ).toBe(200);
  });

  it('clamps confidence and defaults to 0 when missing', () => {
    expect(sanitizeOcrResult({ confidence: 2 }).confidence).toBe(1);
    expect(sanitizeOcrResult({ confidence: -1 }).confidence).toBe(0);
    expect(sanitizeOcrResult({}).confidence).toBe(0);
  });

  it('returns a trimmed note (or null when blank)', () => {
    expect(sanitizeOcrResult({ note: '  subtotal only  ' }).note).toBe(
      'subtotal only',
    );
    expect(sanitizeOcrResult({ note: '   ' }).note).toBeNull();
    expect(sanitizeOcrResult({}).note).toBeNull();
  });
});
