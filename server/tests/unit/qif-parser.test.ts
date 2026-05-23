import { describe, it, expect } from 'vitest';
import { parseQif, parseQifDate } from '../../src/import/parsers/qif.js';
import { fixtureBuffer } from '../setup/fixtures.js';

describe('QIF parser (0.11.0)', () => {
  it('parses the canonical fixture', () => {
    const r = parseQif(fixtureBuffer('sample.qif'));
    expect(r.formatId).toBe('qif');
    expect(r.errors).toHaveLength(0);
    expect(r.transactions).toHaveLength(3);

    const [a, b, c] = r.transactions;
    expect(a!.txnDate).toBe('2026-03-12');
    expect(a!.amountCents).toBe(-4218);
    expect(a!.rawDescription).toBe('Starbucks #1234');
    expect(a!.sourceCategory).toBe('Coffee Shops');
    expect(a!.memo).toBe('Airport');

    expect(b!.amountCents).toBe(150000);
    expect(b!.sourceCategory).toBe('Income');

    expect(c!.txnDate).toBe('2026-03-14'); // ISO date branch
    expect(c!.memo).toBe('ref 1234'); // N field rolled into memo
  });

  it('handles a record without a trailing ^ terminator', () => {
    const text = ['!Type:Bank', 'D04/01/2026', 'T-1.23', 'PTrailing'].join('\n');
    const r = parseQif(Buffer.from(text, 'utf-8'));
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]!.amountCents).toBe(-123);
  });

  it('skips ignored sections (!Account, !Type:Cat) without crashing', () => {
    const text = [
      '!Account',
      'NMy Checking',
      'TBank',
      '^',
      '!Type:Cat',
      'NSomeCategory',
      '^',
      '!Type:Bank',
      'D03/01/2026',
      'T-10.00',
      'PReal Txn',
      '^',
    ].join('\n');
    const r = parseQif(Buffer.from(text, 'utf-8'));
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]!.rawDescription).toBe('Real Txn');
  });

  it('records an error for a malformed amount but keeps going', () => {
    const text = [
      '!Type:Bank',
      'D03/01/2026',
      'Tnot-a-number',
      'PBad Row',
      '^',
      'D03/02/2026',
      'T1.00',
      'PGood Row',
      '^',
    ].join('\n');
    const r = parseQif(Buffer.from(text, 'utf-8'));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/Invalid amount/);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]!.rawDescription).toBe('Good Row');
  });

  it('parses apostrophe-year dates (Quicken `1/3\'05` -> 2005-01-03)', () => {
    expect(parseQifDate("1/3'05")).toBe('2005-01-03');
    expect(parseQifDate("12/31'26")).toBe('2026-12-31');
  });

  it('parses 2-digit slash years per the <70 / >=70 pivot', () => {
    expect(parseQifDate('1/3/95')).toBe('1995-01-03');
    expect(parseQifDate('1/3/05')).toBe('2005-01-03');
  });

  it('rejects garbage dates', () => {
    expect(() => parseQifDate('not a date')).toThrow(/Unrecognized QIF date/);
    expect(() => parseQifDate('13/40/2026')).toThrow(/invalid month/);
  });
});
