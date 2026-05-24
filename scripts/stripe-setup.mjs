#!/usr/bin/env node
// 0.15.x — provision Stripe products + prices for the SaaS pricing
// defined in docs/SAAS_PLAN.md. Idempotent: re-runs are no-ops once
// everything exists.
//
// Reads STRIPE_SECRET_KEY from .env. Refuses to run against a
// live-mode key (starts with sk_live_) — pasting a production key
// into a "setup my dev environment" script is the kind of accident
// this guards against.
//
// Usage:
//   node scripts/stripe-setup.mjs                  # create / verify
//   node scripts/stripe-setup.mjs --portal-only    # just configure Customer Portal
//   node scripts/stripe-setup.mjs --dry-run        # print what would happen
//
// What it creates:
//   3 products:
//     prod_smrtcash_starter  — SmrtCash Starter
//     prod_smrtcash_plus     — SmrtCash Plus
//     prod_smrtcash_family   — SmrtCash Family
//   6 prices, addressable by lookup_key:
//     starter_monthly $7.99/mo    starter_annual $59/yr
//     plus_monthly    $13.99/mo   plus_annual    $99/yr
//     family_monthly  $19.99/mo   family_annual  $149/yr
//   1 Customer Portal config:
//     Return URL = STRIPE_PUBLIC_BASE_URL/billing
//     Self-service: cancel + update payment method + update billing details
//     Subscription update: allow plan-change between starter/plus/family

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
loadEnv({ path: join(repoRoot, '.env') });

// ── Configuration ────────────────────────────────────────────

const PLANS = [
  {
    productId: 'smrtcash-starter',
    name: 'SmrtCash Starter',
    description:
      'Manual budgeting + file import. Unlimited accounts. No bank sync.',
    prices: [
      { lookupKey: 'starter_monthly', amountCents: 799, interval: 'month' },
      { lookupKey: 'starter_annual',  amountCents: 5900, interval: 'year' },
    ],
  },
  {
    productId: 'smrtcash-plus',
    name: 'SmrtCash Plus',
    description:
      'Bank sync (10 institutions), AI assistant, receipt OCR, anomaly alerts, ' +
      'tax reports, crypto, multi-currency, retirement projections.',
    prices: [
      { lookupKey: 'plus_monthly', amountCents: 1399, interval: 'month' },
      { lookupKey: 'plus_annual',  amountCents: 9900, interval: 'year' },
    ],
  },
  {
    productId: 'smrtcash-family',
    name: 'SmrtCash Family',
    description:
      'Everything in Plus, plus up to 6 household members with per-account permissions, ' +
      'bill splitting, unlimited AI + OCR, 25-institution bank sync.',
    prices: [
      { lookupKey: 'family_monthly', amountCents: 1999, interval: 'month' },
      { lookupKey: 'family_annual',  amountCents: 14900, interval: 'year' },
    ],
  },
];

// ── Arg parsing ──────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, portalOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--portal-only') args.portalOnly = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/stripe-setup.mjs                # create / verify products + prices',
      '  node scripts/stripe-setup.mjs --portal-only  # just configure Customer Portal',
      '  node scripts/stripe-setup.mjs --dry-run      # print what would happen',
    ].join('\n'),
  );
}

// ── Stripe HTTP client (no SDK dependency for one-shot setup) ─

function fmt(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

class Stripe {
  constructor(secretKey) {
    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY is required (set it in .env).');
    }
    if (secretKey.startsWith('sk_live_')) {
      throw new Error(
        'Refusing to run against a LIVE key (sk_live_...). This script is ' +
          'for test-mode setup only. Re-run with a sk_test_... key.',
      );
    }
    if (!secretKey.startsWith('sk_')) {
      throw new Error(
        `STRIPE_SECRET_KEY doesn't look right (got "${secretKey.slice(0, 8)}..."). ` +
          'It should start with "sk_test_" for test mode.',
      );
    }
    this.secretKey = secretKey;
  }

  async req(method, path, params) {
    const url = `https://api.stripe.com${path}`;
    const headers = {
      Authorization: `Bearer ${this.secretKey}`,
      'Stripe-Version': '2024-11-20.acacia',
    };
    let body;
    if (params) {
      const form = new URLSearchParams();
      flatten(params, '', form);
      body = form.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Stripe returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = parsed?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`Stripe ${method} ${path} failed: ${msg}`);
    }
    return parsed;
  }
}

// Stripe accepts nested params as bracket notation in form bodies.
// e.g. {features: {invoice_history: {enabled: true}}} →
// features[invoice_history][enabled]=true
function flatten(value, prefix, into) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, into));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      flatten(v, prefix ? `${prefix}[${k}]` : k, into);
    }
  } else {
    into.append(prefix, String(value));
  }
}

// ── Provisioning ─────────────────────────────────────────────

async function ensureProductsAndPrices(stripe, dryRun) {
  // Fetch existing prices keyed by lookup_key in one call (up to 6).
  const allLookupKeys = PLANS.flatMap((p) => p.prices.map((pr) => pr.lookupKey));
  const existingPricesByLookup = new Map();
  for (const lookup of allLookupKeys) {
    const r = await stripe.req('GET', `/v1/prices?lookup_keys[]=${lookup}&expand[]=data.product&limit=1`);
    if (r.data.length > 0) {
      existingPricesByLookup.set(lookup, r.data[0]);
    }
  }

  // Resolve product IDs: for each plan, find or create by `metadata.smrtcash_product_id`.
  // Stripe doesn't have a per-account stable handle for products, so we
  // tag every product we create with metadata.smrtcash_product_id =
  // 'smrtcash-starter' / 'smrtcash-plus' / 'smrtcash-family' and look
  // up by that.
  const productByPlan = new Map();
  for (const plan of PLANS) {
    // First, see if any existing price has a linked product matching.
    let productId = null;
    for (const price of plan.prices) {
      const existing = existingPricesByLookup.get(price.lookupKey);
      if (existing) {
        productId = typeof existing.product === 'string'
          ? existing.product
          : existing.product.id;
        break;
      }
    }
    if (!productId) {
      // Search by metadata.smrtcash_product_id. The list endpoint
      // doesn't filter on metadata, so list active products and scan.
      const list = await stripe.req('GET', '/v1/products?active=true&limit=100');
      const found = list.data.find(
        (p) => p.metadata?.smrtcash_product_id === plan.productId,
      );
      if (found) {
        productId = found.id;
      }
    }
    if (!productId) {
      // Create.
      if (dryRun) {
        console.log(`  [dry-run] would CREATE product: ${plan.name}`);
        productId = `(would-be-created-${plan.productId})`;
      } else {
        const created = await stripe.req('POST', '/v1/products', {
          name: plan.name,
          description: plan.description,
          metadata: { smrtcash_product_id: plan.productId },
        });
        productId = created.id;
        console.log(`  ✓ created product ${plan.name}  (${productId})`);
      }
    } else {
      console.log(`  · product ${plan.name} already exists  (${productId})`);
    }
    productByPlan.set(plan.productId, productId);
  }

  // Create any missing prices.
  for (const plan of PLANS) {
    for (const price of plan.prices) {
      const existing = existingPricesByLookup.get(price.lookupKey);
      if (existing) {
        // Sanity check: amount / interval match what we expect?
        const amountMatch = existing.unit_amount === price.amountCents;
        const intervalMatch = existing.recurring?.interval === price.interval;
        if (!amountMatch || !intervalMatch) {
          console.warn(
            `  ! price ${price.lookupKey} exists but values drift:\n` +
              `    expected: ${fmt(price.amountCents)} / ${price.interval}\n` +
              `    actual:   ${fmt(existing.unit_amount)} / ${existing.recurring?.interval}`,
          );
          console.warn(
            `    (Stripe prices are immutable. Archive the old one in the dashboard ` +
              `and re-run to create a fresh one with the same lookup_key.)`,
          );
        } else {
          console.log(
            `  · price ${price.lookupKey} already exists  (${existing.id})  ${fmt(existing.unit_amount)} / ${existing.recurring?.interval}`,
          );
        }
        continue;
      }
      if (dryRun) {
        console.log(
          `  [dry-run] would CREATE price ${price.lookupKey}  ${fmt(price.amountCents)} / ${price.interval}`,
        );
        continue;
      }
      const created = await stripe.req('POST', '/v1/prices', {
        product: productByPlan.get(plan.productId),
        unit_amount: price.amountCents,
        currency: 'usd',
        recurring: { interval: price.interval },
        lookup_key: price.lookupKey,
        transfer_lookup_key: true,
      });
      console.log(
        `  ✓ created price ${price.lookupKey}  (${created.id})  ${fmt(price.amountCents)} / ${price.interval}`,
      );
    }
  }
}

async function ensureCustomerPortal(stripe, baseUrl, dryRun) {
  // Find existing config (Stripe allows 1 active configuration per account
  // in test mode unless you specifically build multi-config flows). We just
  // ensure ONE config exists with sensible defaults.
  const list = await stripe.req('GET', '/v1/billing_portal/configurations?active=true&limit=10');
  const ours = list.data.find(
    (c) => c.metadata?.smrtcash_portal === 'true',
  );

  // Build the price lookup table (only including active prices) so
  // plan-change in the portal is well-defined.
  const pricesResp = await stripe.req(
    'GET',
    '/v1/prices?lookup_keys[]=starter_monthly&lookup_keys[]=starter_annual' +
      '&lookup_keys[]=plus_monthly&lookup_keys[]=plus_annual' +
      '&lookup_keys[]=family_monthly&lookup_keys[]=family_annual',
  );
  // Group prices by product.
  const productPrices = new Map();
  for (const p of pricesResp.data) {
    const productId = typeof p.product === 'string' ? p.product : p.product.id;
    const list = productPrices.get(productId) ?? [];
    list.push(p.id);
    productPrices.set(productId, list);
  }
  const subscriptionUpdateProducts = [...productPrices.entries()].map(
    ([product, prices]) => ({ product, prices }),
  );

  if (subscriptionUpdateProducts.length === 0) {
    console.warn(
      '  ! No prices found for plan-change in Customer Portal. ' +
        'Run without --portal-only first to create the products + prices.',
    );
    return;
  }

  const features = {
    customer_update: {
      enabled: true,
      allowed_updates: ['email', 'address', 'tax_id'],
    },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: {
      enabled: true,
      mode: 'at_period_end',
      cancellation_reason: { enabled: true, options: [
        'too_expensive', 'missing_features', 'switched_service',
        'unused', 'customer_service', 'too_complex', 'low_quality', 'other',
      ] },
    },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ['price', 'promotion_code'],
      proration_behavior: 'create_prorations',
      products: subscriptionUpdateProducts,
    },
  };
  const body = {
    business_profile: {
      headline: 'SmrtCash — manage your subscription',
      privacy_policy_url: `${baseUrl}/privacy`,
      terms_of_service_url: `${baseUrl}/terms`,
    },
    default_return_url: `${baseUrl}/billing`,
    features,
    metadata: { smrtcash_portal: 'true' },
  };

  if (ours) {
    if (dryRun) {
      console.log(`  [dry-run] would UPDATE customer portal config (${ours.id})`);
      return;
    }
    const updated = await stripe.req('POST', `/v1/billing_portal/configurations/${ours.id}`, body);
    console.log(`  ✓ updated customer portal config  (${updated.id})`);
  } else {
    if (dryRun) {
      console.log(`  [dry-run] would CREATE customer portal config`);
      return;
    }
    const created = await stripe.req('POST', '/v1/billing_portal/configurations', body);
    console.log(`  ✓ created customer portal config  (${created.id})`);
  }
}

// ── Entrypoint ───────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const baseUrl = process.env.STRIPE_PUBLIC_BASE_URL ?? 'http://localhost:4000';

  console.log(
    args.dryRun
      ? '── DRY RUN — no changes will be written ──'
      : '── stripe-setup ──',
  );
  console.log(`  mode:     test (key prefix ${stripe.secretKey.slice(0, 8)}...)`);
  console.log(`  base url: ${baseUrl}`);
  console.log('');

  if (!args.portalOnly) {
    console.log('Products + prices:');
    await ensureProductsAndPrices(stripe, args.dryRun);
    console.log('');
  }

  console.log('Customer portal:');
  await ensureCustomerPortal(stripe, baseUrl, args.dryRun);
  console.log('');

  console.log('Done.');
  if (!args.dryRun && !args.portalOnly) {
    console.log('');
    console.log(
      'Next: start the CLI listener in another terminal so webhooks land:',
    );
    console.log('  stripe listen --forward-to localhost:4000/api/billing/webhook');
    console.log(
      'Then paste the printed `whsec_...` into .env as STRIPE_WEBHOOK_SECRET.',
    );
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
