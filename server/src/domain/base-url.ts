import { getEffectiveValue } from './settings.js';

/**
 * 0.18.8 — single source of truth for the public-facing base URL.
 *
 * Replaces the two pre-0.18.8 helpers (one in tenants.ts, one in
 * system.ts) that diverged in fallback order and inadvertently let
 * one half of the app keep working when the other half's setting
 * was typo'd. See migration 048's header for the full story.
 *
 * Priority:
 *   1. PUBLIC_BASE_URL setting (or env)
 *   2. STRIPE_PUBLIC_BASE_URL env  ← back-compat for operators
 *   3. APP_BASE_URL env            ← back-compat for operators
 *      who haven't renamed their .env yet
 *   4. Origin header from the request (browser-driven calls)
 *   5. Host + x-forwarded-proto headers
 *   6. http://localhost:4000 (developer machine)
 *
 * Trailing slashes are stripped so callers can append paths safely.
 */
export async function resolveBaseUrl(
  headers: Record<string, unknown>,
): Promise<string> {
  const fromPublic = (await getEffectiveValue('PUBLIC_BASE_URL')).trim();
  if (fromPublic !== '') return fromPublic.replace(/\/+$/, '');

  // Env-only back-compat: getEffectiveValue() can't read these now
  // that they're not in KNOWN_SETTINGS, so check process.env directly.
  const stripeLegacy = (process.env.STRIPE_PUBLIC_BASE_URL ?? '').trim();
  if (stripeLegacy !== '') return stripeLegacy.replace(/\/+$/, '');
  const appLegacy = (process.env.APP_BASE_URL ?? '').trim();
  if (appLegacy !== '') return appLegacy.replace(/\/+$/, '');

  const origin = headers['origin'];
  if (typeof origin === 'string' && origin.startsWith('http')) {
    return origin.replace(/\/+$/, '');
  }
  const proto = headers['x-forwarded-proto'] ?? 'http';
  const host = headers['host'];
  if (typeof host === 'string') {
    return `${String(proto)}://${host}`.replace(/\/+$/, '');
  }
  return 'http://localhost:4000';
}
