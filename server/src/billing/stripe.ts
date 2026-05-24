import Stripe from 'stripe';

let _client: Stripe | null = null;

/**
 * 0.15.1 — lazy-init Stripe SDK client.
 *
 * Why lazy: tests + dev runs without Stripe configured should not
 * blow up at module-import time. The first time billing code wants
 * the client, this fires; if no key is set, the caller catches and
 * 503's the route.
 *
 * API version: deliberately NOT pinned. We use whatever the
 * installed SDK defaults to — the SDK's TypeScript types match its
 * default API version, so leaving the option off keeps types and
 * runtime shape aligned. If you want to lock to a specific version,
 * bump the SDK to one that ships that version as its default rather
 * than overriding here (the type system would yell otherwise).
 */

export function getStripe(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. See docs/STRIPE_SETUP.md for setup.',
    );
  }
  _client = new Stripe(key);
  return _client;
}

/** Test-only: reset the cached client so a different key can take over. */
export function _resetStripeClientForTests(): void {
  _client = null;
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
