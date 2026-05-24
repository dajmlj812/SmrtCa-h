import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  automaticTaxEnabled,
  isStripeConfigured,
} from '../../src/billing/stripe.js';

/**
 * 0.15.5 — env-var-driven Stripe config helpers.
 *
 * Pure functions reading process.env at call time. We reset the
 * relevant variables around each test so adjacent suites that
 * configure Stripe for their own purposes don't leak in.
 */

describe('billing/stripe config helpers (0.15.5)', () => {
  let originalKey: string | undefined;
  let originalTax: string | undefined;

  beforeEach(() => {
    originalKey = process.env.STRIPE_SECRET_KEY;
    originalTax = process.env.STRIPE_AUTOMATIC_TAX;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalKey;
    if (originalTax === undefined) delete process.env.STRIPE_AUTOMATIC_TAX;
    else process.env.STRIPE_AUTOMATIC_TAX = originalTax;
  });

  describe('isStripeConfigured()', () => {
    it('is false when STRIPE_SECRET_KEY is unset', () => {
      delete process.env.STRIPE_SECRET_KEY;
      expect(isStripeConfigured()).toBe(false);
    });
    it('is true when STRIPE_SECRET_KEY is set to any non-empty string', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      expect(isStripeConfigured()).toBe(true);
    });
    it('is false when STRIPE_SECRET_KEY is the empty string', () => {
      process.env.STRIPE_SECRET_KEY = '';
      expect(isStripeConfigured()).toBe(false);
    });
  });

  describe('automaticTaxEnabled()', () => {
    it('defaults to false when STRIPE_AUTOMATIC_TAX is unset', () => {
      delete process.env.STRIPE_AUTOMATIC_TAX;
      expect(automaticTaxEnabled()).toBe(false);
    });
    it('is true when STRIPE_AUTOMATIC_TAX is "true" (case-insensitive)', () => {
      for (const v of ['true', 'TRUE', 'True', 'tRuE']) {
        process.env.STRIPE_AUTOMATIC_TAX = v;
        expect(automaticTaxEnabled()).toBe(true);
      }
    });
    it('is false for any other value (including "1", "yes")', () => {
      // Deliberately strict — only the literal string "true" enables.
      // "1" / "yes" are not honored to keep the contract single-pivot
      // and avoid surprise enables from sloppy automation.
      for (const v of ['1', 'yes', 'on', 'false', 'no', 'off', '']) {
        process.env.STRIPE_AUTOMATIC_TAX = v;
        expect(automaticTaxEnabled()).toBe(false);
      }
    });
  });
});
