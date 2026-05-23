import { describe, it, expect } from 'vitest';
import {
  detectRecurring,
  type RecurringInput,
} from '../../src/domain/recurring.js';

function txn(
  id: string,
  date: string,
  amount: number,
  merchant: string | null,
  desc = 'X',
): RecurringInput {
  return {
    id,
    date,
    amount_cents: amount,
    normalized_merchant: merchant,
    raw_description: desc,
  };
}

describe('detectRecurring', () => {
  it('detects a monthly subscription with 3 occurrences', () => {
    const out = detectRecurring([
      txn('a', '2026-03-01', -1499, 'Netflix'),
      txn('b', '2026-04-01', -1499, 'Netflix'),
      txn('c', '2026-05-01', -1499, 'Netflix'),
    ]);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect(s.kind).toBe('bill');
    expect(s.detectedFrequency).toBe('monthly');
    expect(s.amountCents).toBe(1499);
    expect(s.confidence).toBeGreaterThan(0.6);
    // Newest sample first.
    expect(s.sampleTxnIds[0]).toBe('c');
  });

  it('detects biweekly direct deposit as income', () => {
    const out = detectRecurring([
      txn('a', '2026-03-06', 250000, 'ACME PAYROLL'),
      txn('b', '2026-03-20', 250000, 'ACME PAYROLL'),
      txn('c', '2026-04-03', 250000, 'ACME PAYROLL'),
      txn('d', '2026-04-17', 250000, 'ACME PAYROLL'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('income');
    expect(out[0]!.detectedFrequency).toBe('biweekly');
  });

  it('detects weekly cadence', () => {
    const out = detectRecurring([
      txn('a', '2026-04-05', -2500, 'TRADER JOES'),
      txn('b', '2026-04-12', -2400, 'TRADER JOES'),
      txn('c', '2026-04-19', -2600, 'TRADER JOES'),
      txn('d', '2026-04-26', -2500, 'TRADER JOES'),
    ]);
    expect(out[0]!.detectedFrequency).toBe('weekly');
  });

  it('classifies erratic spacing as unknown but still surfaces it', () => {
    const out = detectRecurring([
      txn('a', '2026-03-01', -1000, 'CHAOS'),
      txn('b', '2026-03-04', -1000, 'CHAOS'),
      txn('c', '2026-05-29', -1000, 'CHAOS'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.detectedFrequency).toBe('unknown');
    expect(out[0]!.confidence).toBeLessThan(0.5);
  });

  it('uses the median amount so an outlier does not skew the suggestion', () => {
    const out = detectRecurring([
      txn('a', '2026-03-01', -1500, 'Spotify'),
      txn('b', '2026-04-01', -1500, 'Spotify'),
      txn('c', '2026-05-01', -9900, 'Spotify'), // outlier
      txn('d', '2026-06-01', -1500, 'Spotify'),
    ]);
    expect(out[0]!.amountCents).toBe(1500);
  });

  it('separates incoming and outgoing flows on the same merchant', () => {
    const out = detectRecurring([
      txn('a', '2026-03-01', -1500, 'Acme'),
      txn('b', '2026-04-01', -1500, 'Acme'),
      txn('c', '2026-05-01', -1500, 'Acme'),
      txn('d', '2026-03-15', 5000, 'Acme'),
      txn('e', '2026-04-15', 5000, 'Acme'),
      txn('f', '2026-05-15', 5000, 'Acme'),
    ]);
    expect(out).toHaveLength(2);
    const bill = out.find((s) => s.kind === 'bill');
    const income = out.find((s) => s.kind === 'income');
    expect(bill?.detectedFrequency).toBe('monthly');
    expect(income?.detectedFrequency).toBe('monthly');
  });

  it('skips groups with fewer than 3 occurrences', () => {
    const out = detectRecurring([
      txn('a', '2026-03-01', -1500, 'Once'),
      txn('b', '2026-04-01', -1500, 'Once'),
    ]);
    expect(out).toHaveLength(0);
  });

  it('falls back to raw_description when normalized_merchant is null', () => {
    const out = detectRecurring([
      txn('a', '2026-03-01', -2000, null, 'COMCAST XFINITY'),
      txn('b', '2026-04-01', -2000, null, 'COMCAST XFINITY'),
      txn('c', '2026-05-01', -2000, null, 'COMCAST XFINITY'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.normalizedKey).toMatch(/COMCAST/);
  });

  it('orders results by confidence (highest first)', () => {
    const out = detectRecurring([
      // Tight monthly → high confidence.
      txn('a', '2026-03-01', -1500, 'Tight'),
      txn('b', '2026-04-01', -1500, 'Tight'),
      txn('c', '2026-05-01', -1500, 'Tight'),
      txn('d', '2026-06-01', -1500, 'Tight'),
      // Loose monthly → lower.
      txn('e', '2026-03-01', -2000, 'Loose'),
      txn('f', '2026-04-06', -2000, 'Loose'),
      txn('g', '2026-05-12', -2000, 'Loose'),
    ]);
    expect(out[0]!.name).toBe('Tight');
    expect(out[0]!.confidence).toBeGreaterThan(out[1]!.confidence);
  });
});
