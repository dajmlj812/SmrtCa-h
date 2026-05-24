import { pool } from '../db/pool.js';

/**
 * 0.15.5 — SaaS operator metrics.
 *
 * Pulls the small set of numbers an operator wants on one screen
 * when triaging a SaaS deployment:
 *
 *   - How many tenants exist; how many are paying.
 *   - Subscription distribution by plan + status (find the long
 *     tail of past_due / unpaid before customers email in).
 *   - Webhook ingest health (we 200 every Stripe delivery so
 *     "received" is all we can observe; if this number is flat
 *     while you'd expect traffic, Stripe → server delivery is
 *     broken upstream).
 *
 * Every query is a single COUNT or GROUP-BY against a small index;
 * cheap enough to power the health page on a 5-second poll.
 */

export interface SaasMetrics {
  generated_at: string;
  tenants: {
    total: number;
    with_active_sub: number;
  };
  subscriptions: {
    total: number;
    by_plan: { starter: number; plus: number; family: number };
    by_status: Record<string, number>;
  };
  webhooks: {
    processed_total: number;
    processed_24h: number;
    last_event_at: string | null;
  };
}

export async function collectSaasMetrics(): Promise<SaasMetrics> {
  const [tenants, subs, webhooks] = await Promise.all([
    collectTenants(),
    collectSubscriptions(),
    collectWebhooks(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    tenants,
    subscriptions: subs,
    webhooks,
  };
}

async function collectTenants(): Promise<SaasMetrics['tenants']> {
  // Two single-row counts; cheaper than joining and lets a deployment
  // with zero subscriptions still report total tenant count.
  const total = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM tenants`,
  );
  // "Active" = whatever effectivePlan would call entitled at the SQL
  // layer. We mirror the helper's rules approximately: trialing,
  // active, past_due, or canceled-with-grace.
  const paying = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM subscriptions
      WHERE status IN ('trialing', 'active', 'past_due')
         OR (status = 'canceled'
             AND cancel_at_period_end = true
             AND current_period_end > now())`,
  );
  return {
    total: Number(total.rows[0]?.n ?? 0),
    with_active_sub: Number(paying.rows[0]?.n ?? 0),
  };
}

async function collectSubscriptions(): Promise<SaasMetrics['subscriptions']> {
  const total = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM subscriptions`,
  );
  const byPlan = await pool.query<{ plan_id: string; n: string }>(
    `SELECT plan_id, COUNT(*)::text AS n FROM subscriptions GROUP BY plan_id`,
  );
  const byStatus = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM subscriptions GROUP BY status`,
  );
  const planCounts = { starter: 0, plus: 0, family: 0 } as Record<
    'starter' | 'plus' | 'family',
    number
  >;
  for (const r of byPlan.rows) {
    if (r.plan_id === 'starter' || r.plan_id === 'plus' || r.plan_id === 'family') {
      planCounts[r.plan_id] = Number(r.n);
    }
  }
  const statusCounts: Record<string, number> = {};
  for (const r of byStatus.rows) {
    statusCounts[r.status] = Number(r.n);
  }
  return {
    total: Number(total.rows[0]?.n ?? 0),
    by_plan: planCounts,
    by_status: statusCounts,
  };
}

async function collectWebhooks(): Promise<SaasMetrics['webhooks']> {
  // stripe_processed_events keeps one row per accepted event_id; the
  // table never deletes so processed_total is monotonic.
  const total = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM stripe_processed_events`,
  );
  const last24h = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM stripe_processed_events
      WHERE processed_at > now() - interval '24 hours'`,
  );
  const lastAt = await pool.query<{ processed_at: string | null }>(
    `SELECT MAX(processed_at)::text AS processed_at
       FROM stripe_processed_events`,
  );
  return {
    processed_total: Number(total.rows[0]?.n ?? 0),
    processed_24h: Number(last24h.rows[0]?.n ?? 0),
    last_event_at: lastAt.rows[0]?.processed_at ?? null,
  };
}
