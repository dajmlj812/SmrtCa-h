import { pool } from '../db/pool.js';

/**
 * 0.15.0 — SaaS entitlement core.
 *
 * Pure data + helpers. NO route is wired against this in 0.15.0;
 * that's 0.15.2. This file's job is to define WHAT plans exist,
 * WHAT each one entitles, and provide the gating primitives that
 * routes will adopt later.
 *
 * Source of truth for the tier/feature mapping is `docs/SAAS_PLAN.md`.
 * Any change here MUST update that doc too.
 */

// ── Plan + feature taxonomy ─────────────────────────────────

export type Plan = 'starter' | 'plus' | 'family';

/**
 * Feature keys. Each premium route in 0.15.2 will pass one of these
 * to `requireFeature`. Add a new key here when adding a new gated
 * surface, and update PLAN_FEATURES below.
 */
export const FEATURES = {
  BANK_SYNC: 'BANK_SYNC',                       // Plaid + OFX-DC + scheduled auto-sync
  AI_NORMALIZE: 'AI_NORMALIZE',                 // Claude / Ollama merchant + category cleanup
  AI_ASSISTANT: 'AI_ASSISTANT',                 // Conversational assistant (metered)
  RECEIPT_OCR: 'RECEIPT_OCR',                   // Claude-vision OCR (metered)
  ANOMALY_ALERTS: 'ANOMALY_ALERTS',
  TAX_REPORTS: 'TAX_REPORTS',
  CALENDAR_VIEW: 'CALENDAR_VIEW',
  CRYPTO_REFRESH: 'CRYPTO_REFRESH',
  MULTI_CURRENCY: 'MULTI_CURRENCY',
  RETIREMENT_PROJECTIONS: 'RETIREMENT_PROJECTIONS',
  HOUSEHOLD_SEATS: 'HOUSEHOLD_SEATS',           // > 1 tenant member
  PER_ACCOUNT_PERMISSIONS: 'PER_ACCOUNT_PERMISSIONS',
  BILL_SPLITTING: 'BILL_SPLITTING',
} as const;
export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export interface PlanDef {
  /** Boolean feature membership. */
  features: Set<Feature>;
  /**
   * Metered quotas per billing period. Undefined means "unlimited
   * within this plan."
   */
  quotas: {
    aiAssistantToolCalls?: number;
    receiptOcr?: number;
  };
  /**
   * Maximum distinct bank connections (OFX-DC connections + Plaid
   * items, summed). 0 means "no bank sync at all" — checked
   * independently from the BANK_SYNC feature flag because the cap
   * still matters even though the feature is granted.
   */
  bankConnectionCap: number;
  /** Maximum tenant member count (admin + spouses + children). */
  householdMemberCap: number;
}

export const PLAN_FEATURES: Record<Plan, PlanDef> = {
  starter: {
    features: new Set<Feature>(),
    quotas: {},
    bankConnectionCap: 0,
    householdMemberCap: 1,
  },
  plus: {
    features: new Set<Feature>([
      FEATURES.BANK_SYNC,
      FEATURES.AI_NORMALIZE,
      FEATURES.AI_ASSISTANT,
      FEATURES.RECEIPT_OCR,
      FEATURES.ANOMALY_ALERTS,
      FEATURES.TAX_REPORTS,
      FEATURES.CALENDAR_VIEW,
      FEATURES.CRYPTO_REFRESH,
      FEATURES.MULTI_CURRENCY,
      FEATURES.RETIREMENT_PROJECTIONS,
    ]),
    quotas: { aiAssistantToolCalls: 500, receiptOcr: 200 },
    bankConnectionCap: 10,
    householdMemberCap: 1,
  },
  family: {
    features: new Set<Feature>([
      FEATURES.BANK_SYNC,
      FEATURES.AI_NORMALIZE,
      FEATURES.AI_ASSISTANT,
      FEATURES.RECEIPT_OCR,
      FEATURES.ANOMALY_ALERTS,
      FEATURES.TAX_REPORTS,
      FEATURES.CALENDAR_VIEW,
      FEATURES.CRYPTO_REFRESH,
      FEATURES.MULTI_CURRENCY,
      FEATURES.RETIREMENT_PROJECTIONS,
      FEATURES.HOUSEHOLD_SEATS,
      FEATURES.PER_ACCOUNT_PERMISSIONS,
      FEATURES.BILL_SPLITTING,
    ]),
    quotas: {}, // unlimited
    bankConnectionCap: 25,
    householdMemberCap: 6,
  },
};

// ── Subscription state ─────────────────────────────────────

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid'
  | 'paused';

export interface Subscription {
  tenantId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  planId: Plan;
  status: SubscriptionStatus;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** Load a tenant's subscription row, or null if they have none. */
export async function getActiveSubscription(
  tenantId: string,
): Promise<Subscription | null> {
  const r = await pool.query<{
    tenant_id: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    plan_id: Plan;
    status: SubscriptionStatus;
    trial_end: Date | null;
    current_period_end: Date | null;
    cancel_at_period_end: boolean;
  }>(
    `SELECT tenant_id, stripe_customer_id, stripe_subscription_id,
            plan_id, status, trial_end, current_period_end,
            cancel_at_period_end
       FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return {
    tenantId: row.tenant_id,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    planId: row.plan_id,
    status: row.status,
    trialEnd: row.trial_end,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

/**
 * 0.15.4 — how many days past `current_period_end` a past_due
 * subscription remains entitled. After the grace window, the
 * helper returns `null` (same as canceled) so route gates lock.
 *
 * Stripe's default retry cadence for failed invoices is roughly
 * 1d / 3d / 5d / 7d; 3 days gives the customer time to update
 * their card after the first retry without leaving them indefinite
 * free access while Stripe keeps trying.
 */
export const GRACE_DAYS_AFTER_PAST_DUE = 3;

/**
 * Return the tenant's currently-entitled plan, or `null` when they
 * have no active subscription. Treats:
 *   - `trialing` and `active` as fully entitled at their plan.
 *   - `past_due` as entitled within `GRACE_DAYS_AFTER_PAST_DUE` of
 *     `current_period_end`; outside that window, treated as
 *     canceled (returns null). The grace gives the customer time
 *     to update their card after the first failed retry without
 *     leaving them with indefinite free access.
 *   - `canceled` as entitled UNTIL `current_period_end` IF
 *     `cancel_at_period_end` was true (the "I cancelled but my
 *     month is paid through" case). After period end → null.
 *   - Everything else (`incomplete`, `incomplete_expired`,
 *     `unpaid`, `paused`) as not entitled.
 */
export async function effectivePlan(tenantId: string): Promise<Plan | null> {
  const sub = await getActiveSubscription(tenantId);
  if (!sub) return null;
  const now = Date.now();
  switch (sub.status) {
    case 'trialing':
    case 'active':
      return sub.planId;
    case 'past_due': {
      // No period_end on the row means we can't compute a grace
      // window — be lenient (treat as entitled) until the next
      // webhook updates the row.
      if (!sub.currentPeriodEnd) return sub.planId;
      const graceEnd =
        sub.currentPeriodEnd.getTime() + GRACE_DAYS_AFTER_PAST_DUE * 86400_000;
      return now < graceEnd ? sub.planId : null;
    }
    case 'canceled':
      if (
        sub.cancelAtPeriodEnd &&
        sub.currentPeriodEnd &&
        sub.currentPeriodEnd.getTime() > now
      ) {
        return sub.planId;
      }
      return null;
    default:
      return null;
  }
}

// ── Gating helpers ─────────────────────────────────────────

export interface EntitlementDenial {
  status: number;
  error: string;
}

/**
 * Returns null on grant, otherwise an `{status, error}` denial the
 * route can send straight to the reply. Mirrors the rbac helper
 * pattern (`assertAccountWriteAccess`).
 *
 * Denials always 402 (Payment Required) so the web client can
 * distinguish "you need to upgrade" from 403 (forbidden by role).
 */
export async function requireFeature(
  tenantId: string,
  feature: Feature,
): Promise<EntitlementDenial | null> {
  const plan = await effectivePlan(tenantId);
  if (!plan) {
    return {
      status: 402,
      error: 'No active subscription on this tenant',
    };
  }
  if (!PLAN_FEATURES[plan].features.has(feature)) {
    return {
      status: 402,
      error: `Feature "${feature}" requires an upgraded plan`,
    };
  }
  return null;
}

/**
 * Count the tenant's currently-connected bank sources (OFX-DC +
 * Plaid items) and refuse to add another when the plan's cap is hit.
 * Called by the connection-creation routes BEFORE they insert.
 */
export async function requireBankConnectionSlot(
  tenantId: string,
): Promise<EntitlementDenial | null> {
  const plan = await effectivePlan(tenantId);
  if (!plan) {
    return { status: 402, error: 'No active subscription on this tenant' };
  }
  const cap = PLAN_FEATURES[plan].bankConnectionCap;
  if (cap === 0) {
    return {
      status: 402,
      error: 'Bank sync requires an upgraded plan',
    };
  }
  const count = await connectionCount(tenantId);
  if (count >= cap) {
    return {
      status: 402,
      error: `Plan limit reached — ${cap} bank connections (currently ${count}). Upgrade to add more.`,
    };
  }
  return null;
}

/** Live count of OFX-DC connections + Plaid items for one tenant. */
export async function connectionCount(tenantId: string): Promise<number> {
  const r = await pool.query<{ total: string }>(
    `SELECT
       (SELECT COUNT(*) FROM ofx_dc_connections WHERE tenant_id = $1)
     + (SELECT COUNT(*) FROM plaid_items         WHERE tenant_id = $1)
       AS total`,
    [tenantId],
  );
  return Number(r.rows[0]?.total ?? 0);
}

/**
 * Same shape as the household-member cap. Used by the invitations
 * route in 0.15.2 to refuse INSERTs above the plan limit.
 */
export async function requireHouseholdSeat(
  tenantId: string,
): Promise<EntitlementDenial | null> {
  const plan = await effectivePlan(tenantId);
  if (!plan) {
    return { status: 402, error: 'No active subscription on this tenant' };
  }
  const cap = PLAN_FEATURES[plan].householdMemberCap;
  const r = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM memberships WHERE tenant_id = $1`,
    [tenantId],
  );
  const count = Number(r.rows[0]?.count ?? 0);
  if (count >= cap) {
    return {
      status: 402,
      error: `Plan limit reached — ${cap} household members. Upgrade to add more.`,
    };
  }
  return null;
}

// ── Quota metering ─────────────────────────────────────────

export interface QuotaResult {
  granted: boolean;
  remaining: number | null; // null = unlimited
  cap: number | null;
  denial?: EntitlementDenial;
}

/**
 * Atomically count `n` units of usage against the named feature for
 * the tenant's CURRENT billing period. Returns `granted: true` when
 * the increment fits inside the plan's quota (or the quota is
 * unlimited), and `granted: false` with a 402 denial when it would
 * overshoot. Either way the counter is updated by `n` only when
 * granted — callers must not retry on failure or they'll burn the
 * quota.
 *
 * The "current billing period" is derived from the subscription's
 * `current_period_end` minus one calendar month for monthly plans —
 * good enough for the metered features (AI assistant tool calls,
 * receipt OCR pages). When `current_period_end` is null (rare
 * placeholder state before Stripe webhook fires), the period
 * defaults to the current calendar month.
 */
export async function checkAndIncrementQuota(
  tenantId: string,
  feature: Feature,
  n: number = 1,
): Promise<QuotaResult> {
  if (n <= 0) {
    return { granted: true, remaining: null, cap: null };
  }
  const plan = await effectivePlan(tenantId);
  if (!plan) {
    return {
      granted: false,
      remaining: 0,
      cap: 0,
      denial: { status: 402, error: 'No active subscription on this tenant' },
    };
  }
  const planDef = PLAN_FEATURES[plan];
  if (!planDef.features.has(feature)) {
    return {
      granted: false,
      remaining: 0,
      cap: 0,
      denial: {
        status: 402,
        error: `Feature "${feature}" requires an upgraded plan`,
      },
    };
  }
  const cap = quotaForFeature(plan, feature);
  if (cap === null) {
    // Unlimited on this plan — still record usage for analytics,
    // but never deny.
    await bumpCounter(tenantId, feature, n);
    return { granted: true, remaining: null, cap: null };
  }

  // Read-modify-write inside a single SQL statement.
  const { period_start, period_end } = await currentPeriod(tenantId);
  const r = await pool.query<{ count: number }>(
    `INSERT INTO usage_counters (tenant_id, feature_key, period_start, period_end, count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, feature_key, period_start)
       DO UPDATE SET count = usage_counters.count + EXCLUDED.count
     RETURNING count`,
    [tenantId, feature, period_start, period_end, n],
  );
  const newTotal = Number(r.rows[0]!.count);
  if (newTotal > cap) {
    // Roll back the optimistic increment. Cheaper than wrapping in a
    // BEGIN/COMMIT for the common (granted) path.
    await pool.query(
      `UPDATE usage_counters SET count = count - $1
        WHERE tenant_id = $2 AND feature_key = $3 AND period_start = $4`,
      [n, tenantId, feature, period_start],
    );
    return {
      granted: false,
      remaining: 0,
      cap,
      denial: {
        status: 402,
        error: `Monthly quota exceeded for "${feature}" — used ${newTotal - n}/${cap}. Upgrade for more.`,
      },
    };
  }
  return { granted: true, remaining: cap - newTotal, cap };
}

function quotaForFeature(plan: Plan, feature: Feature): number | null {
  const q = PLAN_FEATURES[plan].quotas;
  switch (feature) {
    case FEATURES.AI_ASSISTANT:
      return q.aiAssistantToolCalls ?? null;
    case FEATURES.RECEIPT_OCR:
      return q.receiptOcr ?? null;
    default:
      return null;
  }
}

async function bumpCounter(
  tenantId: string,
  feature: Feature,
  n: number,
): Promise<void> {
  const { period_start, period_end } = await currentPeriod(tenantId);
  await pool.query(
    `INSERT INTO usage_counters (tenant_id, feature_key, period_start, period_end, count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, feature_key, period_start)
       DO UPDATE SET count = usage_counters.count + EXCLUDED.count`,
    [tenantId, feature, period_start, period_end, n],
  );
}

interface BillingWindow {
  period_start: string; // YYYY-MM-DD
  period_end: string;   // YYYY-MM-DD
}

/**
 * The (start, end) for the tenant's current billing period.
 * Anchored on `subscriptions.current_period_end`: we work backwards
 * one calendar month from that timestamp. When no subscription exists
 * (signup-but-pre-webhook race), default to the current calendar
 * month. Returns YYYY-MM-DD date strings suitable for the `date`
 * columns.
 */
async function currentPeriod(tenantId: string): Promise<BillingWindow> {
  const sub = await getActiveSubscription(tenantId);
  if (!sub || !sub.currentPeriodEnd) {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { period_start: ymd(start), period_end: ymd(end) };
  }
  const end = sub.currentPeriodEnd;
  // Walk back one calendar month. For annual plans Stripe still
  // gives us a `current_period_end` 12 months out — that's fine,
  // quotas are intentionally month-sized regardless of billing cadence.
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return { period_start: ymd(start), period_end: ymd(end) };
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
