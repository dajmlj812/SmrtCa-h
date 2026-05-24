import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb } from '../setup/test-db.js';

/**
 * 0.15.1 — sanity tests at the route layer. The webhook signature
 * dance + Checkout session creation require a real Stripe test
 * account, so the deep paths are covered manually via
 * `stripe trigger ...` (see docs/STRIPE_SETUP.md). What we verify
 * here is the contract that DOES NOT need a live Stripe API:
 *
 *   - webhook 400s a request with no signature
 *   - webhook 400s a request with an invalid signature
 *   - checkout 503s when Stripe isn't configured
 *   - portal 503s when Stripe isn't configured
 *
 * Reads STRIPE_SECRET_KEY env to decide which suite branches to
 * run — when keys ARE set (running locally against a test-mode
 * account) the 503 expectations flip. We default-skip those.
 */

describe('Billing routes — signature + 503 contracts (0.15.1)', () => {
  let app: FastifyInstance;
  const hadStripe = Boolean(process.env.STRIPE_SECRET_KEY);

  beforeAll(async () => {
    // Force no Stripe for these tests so the 503 path is exercised.
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
    if (hadStripe) {
      // Restore for any subsequent suites that may rely on it.
      // (We intentionally don't restore the actual value here —
      // that's read from .env at process start.)
    }
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('POST /api/billing/checkout 503s when Stripe is not configured', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { lookupKey: 'plus_annual' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/not configured/i);
  });

  it('POST /api/billing/webhook 503s when Stripe is not configured', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      payload: { type: 'irrelevant' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(503);
  });

  it('GET /api/billing/portal 503s when Stripe is not configured', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/billing/portal',
    });
    expect(r.statusCode).toBe(503);
  });

  it('webhook 400s on missing signature (when Stripe IS configured)', async () => {
    // Need a key for the route to get past the 503 gate. Use a
    // dummy sk_test_ — the route only checks process.env, doesn't
    // actually hit Stripe until signature-verify.
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_for_signature_tests';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
    try {
      // Need a fresh app instance because isStripeConfigured() is
      // evaluated per-request via process.env, but we built the app
      // with no key set.
      const liveApp = await makeTestApp();
      const r = await liveApp.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        payload: { type: 'irrelevant' },
        headers: { 'content-type': 'application/json' },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/signature/i);
      await liveApp.close();
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });

  it('webhook 400s on invalid signature', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_for_signature_tests';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
    try {
      const liveApp = await makeTestApp();
      const r = await liveApp.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        payload: { type: 'foo' },
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'not-a-real-signature',
        },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/signature/i);
      await liveApp.close();
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });
});
