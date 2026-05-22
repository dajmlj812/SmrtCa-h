import { describe, it, expect } from 'vitest';
import { parseDateToISO } from '../../src/domain/dates.js';

describe('parseDateToISO', () => {
  it('parses US month/day/year dates', () => {
    expect(parseDateToISO('05/20/2026')).toBe('2026-05-20');
    expect(parseDateToISO('12/31/2026')).toBe('2026-12-31');
  });

  it('zero-pads single-digit months and days', () => {
    expect(parseDateToISO('5/3/2026')).toBe('2026-05-03');
  });

  it('accepts ISO dates unchanged', () => {
    expect(parseDateToISO('2026-05-20')).toBe('2026-05-20');
  });

  it('accepts dash-separated dates', () => {
    expect(parseDateToISO('05-20-2026')).toBe('2026-05-20');
  });

  it('expands two-digit years', () => {
    expect(parseDateToISO('05/20/26')).toBe('2026-05-20');
    expect(parseDateToISO('05/20/99')).toBe('1999-05-20');
  });

  it('honors day/month/year order when requested', () => {
    expect(parseDateToISO('20/05/2026', 'dmy')).toBe('2026-05-20');
  });

  it('throws on empty or unrecognized input', () => {
    expect(() => parseDateToISO('')).toThrow();
    expect(() => parseDateToISO('not-a-date')).toThrow();
  });

  it('throws on impossible month or day values', () => {
    expect(() => parseDateToISO('99/99/9999')).toThrow();
    expect(() => parseDateToISO('13/01/2026')).toThrow();
    expect(() => parseDateToISO('01/45/2026')).toThrow();
  });
});
