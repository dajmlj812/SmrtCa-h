import { describe, it, expect } from 'vitest';
import {
  ALL_LOOKUP_KEYS,
  isKnownLookupKey,
  lookupKeyFor,
  planFromLookupKey,
} from '../../src/billing/plans.js';

describe('billing/plans (0.15.1)', () => {
  it('exposes exactly 6 lookup keys — 3 plans × 2 cadences', () => {
    expect(ALL_LOOKUP_KEYS).toHaveLength(6);
    expect(new Set(ALL_LOOKUP_KEYS)).toEqual(
      new Set([
        'starter_monthly', 'starter_annual',
        'plus_monthly',    'plus_annual',
        'family_monthly',  'family_annual',
      ]),
    );
  });

  it('planFromLookupKey resolves known keys', () => {
    expect(planFromLookupKey('plus_monthly')).toEqual({ plan: 'plus', cadence: 'monthly' });
    expect(planFromLookupKey('family_annual')).toEqual({ plan: 'family', cadence: 'annual' });
  });

  it('planFromLookupKey returns null for unknown keys', () => {
    expect(planFromLookupKey('enterprise_quarterly')).toBeNull();
    expect(planFromLookupKey('')).toBeNull();
  });

  it('lookupKeyFor inverts cleanly', () => {
    expect(lookupKeyFor('starter', 'monthly')).toBe('starter_monthly');
    expect(lookupKeyFor('family', 'annual')).toBe('family_annual');
    // Round-trip through both.
    for (const key of ALL_LOOKUP_KEYS) {
      const resolved = planFromLookupKey(key)!;
      expect(lookupKeyFor(resolved.plan, resolved.cadence)).toBe(key);
    }
  });

  it('isKnownLookupKey is a thin guard', () => {
    expect(isKnownLookupKey('plus_annual')).toBe(true);
    expect(isKnownLookupKey('plus_yearly')).toBe(false);
  });
});
