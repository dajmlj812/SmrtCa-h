import { describe, it, expect } from 'vitest';
import {
  formatCents,
  formatDate,
  accountTypeLabel,
} from '../../src/format';

describe('formatCents', () => {
  it('formats positive and negative amounts as USD currency', () => {
    expect(formatCents(141900)).toBe('$1,419.00');
    expect(formatCents(-999)).toBe('-$9.99');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
  });

  it('renders a dash for missing values', () => {
    expect(formatCents(null)).toBe('—');
    expect(formatCents(undefined)).toBe('—');
  });
});

describe('formatDate', () => {
  it('formats an ISO date as MM/DD/YYYY', () => {
    expect(formatDate('2026-05-20')).toBe('05/20/2026');
    expect(formatDate('2026-12-31')).toBe('12/31/2026');
  });

  it('renders a dash for missing values', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
  });
});

describe('accountTypeLabel', () => {
  it('maps known account-type codes to readable labels', () => {
    expect(accountTypeLabel('credit_card')).toBe('Credit Card');
    expect(accountTypeLabel('checking')).toBe('Checking');
    expect(accountTypeLabel('savings')).toBe('Savings');
  });

  it('returns the raw code for an unknown type', () => {
    expect(accountTypeLabel('mystery_type')).toBe('mystery_type');
  });
});
