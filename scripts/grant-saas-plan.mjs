#!/usr/bin/env node
// 0.15.0 — dev / operator script to grant a SaaS subscription to a
// tenant directly in the DB, bypassing Stripe.
//
// Use cases:
//   - Bootstrap: give your own Default tenant a Family plan so the
//     0.15.2 route gates don't lock you out before Stripe Checkout
//     ships.
//   - Comp / staff: grant Family to a tenant without billing.
//   - Manual recovery: re-create a row if a webhook was lost and
//     Stripe and our DB drifted (rare; the webhook is idempotent).
//
// Usage:
//   node scripts/grant-saas-plan.mjs --tenant <slug> --plan <plan> [--trial-days <n>]
//
// Examples:
//   # Grant Family to the Default tenant, no trial, "active" status:
//   node scripts/grant-saas-plan.mjs --tenant default --plan family
//
//   # Grant Plus with a 14-day trial:
//   node scripts/grant-saas-plan.mjs --tenant default --plan plus --trial-days 14
//
// Reads DATABASE_URL from .env.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
loadEnv({ path: join(repoRoot, '.env') });

const requireFromServer = createRequire(join(repoRoot, 'server', 'package.json'));
const { Pool } = requireFromServer('pg');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--tenant') args.tenant = argv[++i];
    else if (flag === '--plan') args.plan = argv[++i];
    else if (flag === '--trial-days') args.trialDays = Number(argv[++i]);
    else if (flag === '--help' || flag === '-h') args.help = true;
  }
  return args;
}

const VALID_PLANS = new Set(['starter', 'plus', 'family']);

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/grant-saas-plan.mjs --tenant <slug> --plan <plan> [--trial-days <n>]',
      '',
      '  --tenant       Tenant slug (e.g. "default")',
      '  --plan         starter | plus | family',
      '  --trial-days   If provided, status=trialing and trial_end set N days out.',
      '                 Otherwise status=active.',
    ].join('\n'),
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.tenant || !args.plan) {
    console.error('Missing required --tenant or --plan');
    usage();
    process.exit(1);
  }
  if (!VALID_PLANS.has(args.plan)) {
    console.error(`Invalid --plan "${args.plan}". Must be one of: starter, plus, family.`);
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  try {
    const tenant = await pool.query(
      `SELECT id, name FROM tenants WHERE slug = $1`,
      [args.tenant],
    );
    if (tenant.rowCount === 0) {
      console.error(`No tenant with slug "${args.tenant}"`);
      process.exit(1);
    }
    const tenantId = tenant.rows[0].id;
    const tenantName = tenant.rows[0].name;

    let status = 'active';
    let trialEnd = null;
    if (args.trialDays && args.trialDays > 0) {
      status = 'trialing';
      const end = new Date();
      end.setUTCDate(end.getUTCDate() + args.trialDays);
      trialEnd = end;
    }
    // Use a far-future period_end for grant-by-hand rows; real ones
    // are set by the Stripe webhook in 0.15.1.
    const periodEnd = new Date();
    periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 1);

    const r = await pool.query(
      `INSERT INTO subscriptions
         (tenant_id, plan_id, status, trial_end, current_period_end,
          cancel_at_period_end)
       VALUES ($1, $2, $3, $4, $5, false)
       ON CONFLICT (tenant_id) DO UPDATE SET
         plan_id = EXCLUDED.plan_id,
         status = EXCLUDED.status,
         trial_end = EXCLUDED.trial_end,
         current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = false,
         updated_at = now()
       RETURNING plan_id, status, trial_end::text, current_period_end::text`,
      [tenantId, args.plan, status, trialEnd, periodEnd],
    );

    const row = r.rows[0];
    console.log(
      `Granted ${row.plan_id} (${row.status}) to tenant "${tenantName}" (${tenantId})`,
    );
    if (row.trial_end) console.log(`  trial_end:          ${row.trial_end}`);
    console.log(`  current_period_end: ${row.current_period_end}`);
    console.log(`  (no Stripe IDs — set by webhook when real billing wires up)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
