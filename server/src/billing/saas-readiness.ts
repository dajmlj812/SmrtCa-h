import { getStripe, isStripeConfigured } from './stripe.js';
import { ALL_LOOKUP_KEYS } from './plans.js';
import { getEffectiveValue } from '../domain/settings.js';

/**
 * 0.22.1 — Live-mode Stripe configuration verifier.
 *
 * Runs a fixed set of read-only checks against the live Stripe API
 * + the local settings store + the env. Each check returns
 * structured pass/fail/warn so the UI can render a green/red panel
 * with a one-line "how to fix" hint per failure.
 *
 * The bugs this catches (mostly from our own cutover):
 *   • Wrong key prefix (sk_test in prod env, or vice versa)
 *   • Missing webhook secret
 *   • Missing or renamed lookup_keys (someone edited PLANS but
 *     didn't re-run stripe-setup.mjs)
 *   • Webhook endpoint not registered at the expected URL
 *   • Customer Portal not configured (Stripe will 400 on portal
 *     opens)
 *   • Trailing whitespace / formatting in env values
 *
 * All Stripe API calls run as a single batch on the request. The
 * panel is super-admin-only and not on any auto-refresh, so the
 * cost is bounded (~6-10 API calls per click).
 */

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** What we found / measured. Always populated. */
  detail: string;
  /** Actionable next step when status is fail/warn. */
  fix?: string;
}

export interface ReadinessReport {
  checkedAt: string;
  mode: 'live' | 'test' | 'unknown';
  checks: ReadinessCheck[];
  summary: { pass: number; warn: number; fail: number };
}

export async function runReadiness(): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const checkedAt = new Date().toISOString();

  // ── Secret key shape ─────────────────────────────────────
  const secretKey = (process.env.STRIPE_SECRET_KEY ?? '').trim();
  const hasSecret = secretKey !== '';
  const isLive = secretKey.startsWith('sk_live_');
  const isTest = secretKey.startsWith('sk_test_');
  const mode: ReadinessReport['mode'] = isLive ? 'live' : isTest ? 'test' : 'unknown';

  checks.push({
    id: 'stripe.secret_key.present',
    label: 'Stripe secret key configured',
    status: hasSecret ? 'pass' : 'fail',
    detail: hasSecret
      ? `${secretKey.slice(0, 8)}… (${mode} mode)`
      : 'STRIPE_SECRET_KEY is empty',
    fix: hasSecret
      ? undefined
      : 'Paste a sk_live_… (prod) or sk_test_… (dev) key into /settings → STRIPE_SECRET_KEY.',
  });

  if (hasSecret && !isLive && !isTest) {
    checks.push({
      id: 'stripe.secret_key.format',
      label: 'Stripe secret key format',
      status: 'fail',
      detail: `Key starts with "${secretKey.slice(0, 8)}", expected sk_live_ or sk_test_`,
      fix: 'A valid Stripe secret key starts with sk_live_ (prod) or sk_test_ (dev). Re-paste the value from the Stripe dashboard.',
    });
  }

  // Check for accidental whitespace inside the key (common copy-paste
  // bug; the trim above on the variable is only for the prefix test).
  if (hasSecret && /\s/.test(process.env.STRIPE_SECRET_KEY ?? '')) {
    checks.push({
      id: 'stripe.secret_key.whitespace',
      label: 'Stripe secret key has no whitespace',
      status: 'fail',
      detail: 'STRIPE_SECRET_KEY contains a space or newline',
      fix: 'Re-paste the key carefully; some copy operations include a trailing newline.',
    });
  }

  // ── Webhook secret shape ─────────────────────────────────
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();
  const hasWebhook = webhookSecret !== '';
  const webhookValid = webhookSecret.startsWith('whsec_');
  checks.push({
    id: 'stripe.webhook_secret.present',
    label: 'Stripe webhook signing secret configured',
    status: hasWebhook && webhookValid ? 'pass' : hasWebhook ? 'fail' : 'fail',
    detail: hasWebhook
      ? webhookValid
        ? `${webhookSecret.slice(0, 8)}… (length ${webhookSecret.length})`
        : `Starts with "${webhookSecret.slice(0, 8)}", expected whsec_`
      : 'STRIPE_WEBHOOK_SECRET is empty',
    fix: hasWebhook && webhookValid
      ? undefined
      : 'Create a webhook endpoint in the Stripe dashboard pointing at /api/billing/webhook with 5 events (customer.subscription.{created,updated,deleted} + invoice.payment_{succeeded,failed}), then copy the whsec_… signing secret into /settings.',
  });

  // ── Mode vs PUBLIC_BASE_URL consistency ──────────────────
  const baseUrl = (await getEffectiveValue('PUBLIC_BASE_URL')).trim();
  const isHttpsProd = baseUrl.startsWith('https://') && !/localhost|127\.0\.0\.1|\.test\./i.test(baseUrl);
  checks.push({
    id: 'stripe.mode_vs_base_url',
    label: 'Key mode matches deployment',
    status: !hasSecret
      ? 'warn'
      : isLive && !isHttpsProd
      ? 'warn'
      : isTest && isHttpsProd
      ? 'fail'
      : 'pass',
    detail: `Key mode: ${mode}. Base URL: ${baseUrl || '(unset)'}`,
    fix:
      isLive && !isHttpsProd
        ? 'Live key set but PUBLIC_BASE_URL looks like a dev/test target — Stripe will redirect real customers somewhere they cannot use.'
        : isTest && isHttpsProd
        ? 'PROD URL with a TEST key — real customers will hit Stripe test mode and no money will move. Swap to sk_live_ before announcing.'
        : undefined,
  });

  // ── Stripe API calls (only run when configured) ──────────
  if (!isStripeConfigured()) {
    checks.push({
      id: 'stripe.api',
      label: 'Stripe API reachable',
      status: 'fail',
      detail: 'No secret key — skipping Stripe API checks',
      fix: 'Set STRIPE_SECRET_KEY first; re-run.',
    });
    return finalize(checks, mode, checkedAt);
  }

  const stripe = getStripe();

  // Lookup-key resolution — every price the app expects must exist
  // in this Stripe account.
  try {
    const missing: string[] = [];
    const inactive: string[] = [];
    for (const lookupKey of ALL_LOOKUP_KEYS) {
      const r = await stripe.prices.list({
        lookup_keys: [lookupKey],
        limit: 1,
        active: undefined,
        expand: ['data.product'],
      });
      if (r.data.length === 0) {
        missing.push(lookupKey);
      } else if (!r.data[0]!.active) {
        inactive.push(lookupKey);
      }
    }
    if (missing.length === 0 && inactive.length === 0) {
      checks.push({
        id: 'stripe.lookup_keys',
        label: `All ${ALL_LOOKUP_KEYS.length} plan lookup_keys resolve`,
        status: 'pass',
        detail: ALL_LOOKUP_KEYS.join(', '),
      });
    } else {
      checks.push({
        id: 'stripe.lookup_keys',
        label: 'All plan lookup_keys resolve',
        status: 'fail',
        detail:
          [
            missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
            inactive.length > 0 ? `inactive: ${inactive.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
        fix: 'Re-run `node scripts/stripe-setup.mjs --allow-live` from the dev workstation against this Stripe account to (re-)create the prices.',
      });
    }
  } catch (err) {
    checks.push({
      id: 'stripe.lookup_keys',
      label: 'All plan lookup_keys resolve',
      status: 'fail',
      detail: err instanceof Error ? err.message : 'Stripe API call failed',
      fix: 'Stripe rejected the API call — check the secret key is valid for this account.',
    });
  }

  // Customer Portal — required for /api/billing/portal to work. Stripe
  // requires the portal be configured once via the dashboard or the
  // setup script; without it, portal-open returns a 400.
  try {
    const portals = await stripe.billingPortal.configurations.list({ limit: 1 });
    checks.push({
      id: 'stripe.portal',
      label: 'Customer Portal configured',
      status: portals.data.length > 0 ? 'pass' : 'fail',
      detail:
        portals.data.length > 0
          ? `Configuration ${portals.data[0]!.id} (active: ${portals.data[0]!.active})`
          : 'No Customer Portal configuration found in this account',
      fix:
        portals.data.length > 0
          ? undefined
          : 'Re-run `node scripts/stripe-setup.mjs --allow-live` — the script creates a portal configuration.',
    });
  } catch (err) {
    checks.push({
      id: 'stripe.portal',
      label: 'Customer Portal configured',
      status: 'fail',
      detail: err instanceof Error ? err.message : 'Stripe API call failed',
    });
  }

  // Webhook endpoint registration — confirm there's a webhook in
  // Stripe pointing at our /api/billing/webhook URL. If the operator
  // forgot to create the endpoint in the dashboard, the local
  // STRIPE_WEBHOOK_SECRET will be set but Stripe never fires events.
  try {
    const expectedUrl = baseUrl
      ? `${baseUrl.replace(/\/+$/, '')}/api/billing/webhook`
      : null;
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    const matching = endpoints.data.filter((e) => e.url === expectedUrl);
    if (!expectedUrl) {
      checks.push({
        id: 'stripe.webhook_endpoint',
        label: 'Webhook endpoint registered',
        status: 'warn',
        detail: 'PUBLIC_BASE_URL not set, cannot verify endpoint URL',
        fix: 'Set PUBLIC_BASE_URL first; re-run.',
      });
    } else if (matching.length === 0) {
      checks.push({
        id: 'stripe.webhook_endpoint',
        label: 'Webhook endpoint registered',
        status: 'fail',
        detail: `No endpoint pointing at ${expectedUrl} in this Stripe account (${endpoints.data.length} total endpoints checked)`,
        fix:
          'In the Stripe dashboard → Developers → Webhooks, add an endpoint at ' +
          expectedUrl +
          ' and subscribe to: customer.subscription.created, .updated, .deleted, invoice.payment_succeeded, .payment_failed.',
      });
    } else {
      const ep = matching[0]!;
      const requiredEvents = [
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.payment_succeeded',
        'invoice.payment_failed',
      ];
      const subscribed = new Set(ep.enabled_events);
      const missing = requiredEvents.filter((e) => !subscribed.has(e) && !subscribed.has('*'));
      checks.push({
        id: 'stripe.webhook_endpoint',
        label: 'Webhook endpoint registered',
        status: missing.length === 0 ? 'pass' : 'warn',
        detail:
          missing.length === 0
            ? `${expectedUrl} (status: ${ep.status}, ${ep.enabled_events.length === 0 ? 'all events' : `${ep.enabled_events.length} events`})`
            : `${expectedUrl} is registered but missing events: ${missing.join(', ')}`,
        fix:
          missing.length === 0
            ? undefined
            : 'Edit the endpoint in the Stripe dashboard to subscribe to the missing event types.',
      });
    }
  } catch (err) {
    checks.push({
      id: 'stripe.webhook_endpoint',
      label: 'Webhook endpoint registered',
      status: 'warn',
      detail: err instanceof Error ? err.message : 'Could not list webhook endpoints',
      fix: 'Stripe rejected the API call — the secret key may not have permission to list webhooks.',
    });
  }

  return finalize(checks, mode, checkedAt);
}

function finalize(
  checks: ReadinessCheck[],
  mode: ReadinessReport['mode'],
  checkedAt: string,
): ReadinessReport {
  const summary = checks.reduce(
    (acc, c) => {
      if (c.status === 'pass') acc.pass++;
      else if (c.status === 'warn') acc.warn++;
      else acc.fail++;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
  return { checkedAt, mode, checks, summary };
}
