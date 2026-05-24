import { describe, it, expect } from 'vitest';
import {
  looksLikeOfx,
  parseOfx,
  parseOfxDate,
} from '../../src/import/parsers/ofx.js';
import { fixtureBuffer } from '../setup/fixtures.js';

describe('OFX/QFX parser (0.11.0)', () => {
  it('parses an OFX 1.x SGML file', () => {
    const r = parseOfx(fixtureBuffer('sample.ofx'), 'sample.ofx');
    expect(r.formatId).toBe('ofx');
    expect(r.errors).toHaveLength(0);
    expect(r.transactions).toHaveLength(3);

    const [a, , c] = r.transactions;
    expect(a!.txnDate).toBe('2026-03-01');
    expect(a!.amountCents).toBe(-4218);
    expect(a!.rawDescription).toBe('Starbucks #1234');
    expect(a!.sourceType).toBe('DEBIT');
    expect(a!.memo).toContain('Airport');
    // 0.14.7: FITID is now exposed as ParsedTransaction.bankReference
    // (and used by the dedup hash); it's no longer folded into the
    // memo string.
    expect(a!.bankReference).toBeTruthy();
    expect(a!.memo).not.toContain('fit ');

    expect(c!.amountCents).toBe(-999);
  });

  it('parses a QFX file and labels it correctly', () => {
    const r = parseOfx(fixtureBuffer('sample.qfx'), 'sample.qfx');
    expect(r.formatId).toBe('qfx');
    expect(r.formatName).toBe('Quicken QFX');
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]!.rawDescription).toBe('Whole Foods Market');
    expect(r.transactions[1]!.amountCents).toBe(5000);
  });

  it('parses an OFX 2.x XML file', () => {
    const r = parseOfx(fixtureBuffer('sample-ofx2.ofx'), 'sample-ofx2.ofx');
    expect(r.errors).toHaveLength(0);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]!.txnDate).toBe('2026-02-15');
    expect(r.transactions[0]!.amountCents).toBe(-12345);
    expect(r.transactions[1]!.amountCents).toBe(50000);
  });

  it('looksLikeOfx sniffs both 1.x and 2.x headers', () => {
    expect(looksLikeOfx(fixtureBuffer('sample.ofx'))).toBe(true);
    expect(looksLikeOfx(fixtureBuffer('sample-ofx2.ofx'))).toBe(true);
    expect(looksLikeOfx(Buffer.from('Date,Amount\n2026-01-01,1.00'))).toBe(false);
  });

  it('parseOfxDate accepts YYYYMMDD with optional timestamp/TZ', () => {
    expect(parseOfxDate('20260315')).toBe('2026-03-15');
    expect(parseOfxDate('20260315120000')).toBe('2026-03-15');
    expect(parseOfxDate('20260315120000.000[-5:EST]')).toBe('2026-03-15');
  });

  it('rejects an OFX file with no <OFX> root tag', () => {
    expect(() => parseOfx(Buffer.from('just some text'), 'x.ofx')).toThrow(
      /no <OFX> root/,
    );
  });
});
