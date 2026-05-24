#!/usr/bin/env node
// 0.15.x — print every row in the `subscriptions` table, joined to
// the tenant slug for readability. Quick visual smoke check during
// the SaaS slice development:
//   - Did the webhook fire? (`stripe_*_id` populated?)
//   - What plan/status is each tenant on?
//   - Is anyone in past_due / canceled?
//
// Usage:
//   node scripts/inspect-subscriptions.mjs
//
// Reads DATABASE_URL from .env. Read-only.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
loadEnv({ path: join(repoRoot, '.env') });

const requireFromServer = createRequire(join(repoRoot, 'server', 'package.json'));
const { Pool } = requireFromServer('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT t.slug AS tenant,
              s.plan_id, s.status,
              s.stripe_customer_id, s.stripe_subscription_id,
              s.trial_end::text, s.current_period_end::text,
              s.cancel_at_period_end,
              s.updated_at::text
         FROM subscriptions s
         JOIN tenants t ON t.id = s.tenant_id
        ORDER BY s.updated_at DESC`,
    );
    if (r.rows.length === 0) {
      console.log('(no subscriptions rows)');
      return;
    }
    console.log(JSON.stringify(r.rows, null, 2));

    // Usage-counter rollup for the current period.
    const counters = await pool.query(
      `SELECT t.slug AS tenant, uc.feature_key, uc.count,
              uc.period_start::text, uc.period_end::text
         FROM usage_counters uc
         JOIN tenants t ON t.id = uc.tenant_id
        WHERE uc.period_end >= now()::date
        ORDER BY t.slug, uc.feature_key`,
    );
    if (counters.rows.length > 0) {
      console.log('\nCurrent-period usage:');
      console.log(JSON.stringify(counters.rows, null, 2));
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
