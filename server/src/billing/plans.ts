import type { Plan } from '../auth/entitlements.js';

/**
 * 0.15.1 — Stripe lookup_key → our Plan mapping.
 *
 * Single source of truth for the price catalog. The setup script
 * (`scripts/stripe-setup.mjs`) creates exactly these 6 prices with
 * exactly these lookup_keys; everything else in the SaaS code
 * references them by lookup_key (not by `price_xxxx` ID), so the
 * code is portable across test / staging / live Stripe accounts.
 */

export type Cadence = 'monthly' | 'annual';

export interface PlanCadence {
  plan: Plan;
  cadence: Cadence;
}

const LOOKUP_TO_PLAN: Record<string, PlanCadence> = {
  starter_monthly: { plan: 'starter', cadence: 'monthly' },
  starter_annual:  { plan: 'starter', cadence: 'annual' },
  plus_monthly:    { plan: 'plus',    cadence: 'monthly' },
  plus_annual:     { plan: 'plus',    cadence: 'annual' },
  family_monthly:  { plan: 'family',  cadence: 'monthly' },
  family_annual:   { plan: 'family',  cadence: 'annual' },
};

export const ALL_LOOKUP_KEYS = Object.keys(LOOKUP_TO_PLAN) as ReadonlyArray<string>;

/** Resolve a Stripe lookup_key to our (plan, cadence) pair. */
export function planFromLookupKey(key: string): PlanCadence | null {
  return LOOKUP_TO_PLAN[key] ?? null;
}

/** Inverse: get the lookup_key for a specific (plan, cadence). */
export function lookupKeyFor(plan: Plan, cadence: Cadence): string {
  return `${plan}_${cadence}`;
}

/** Returns true when the key is one we know about. */
export function isKnownLookupKey(key: string): boolean {
  return key in LOOKUP_TO_PLAN;
}
