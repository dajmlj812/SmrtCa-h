import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  FEATURES,
  GRACE_DAYS_AFTER_PAST_DUE,
  PLAN_FEATURES,
  type Plan,
  type SubscriptionStatus,
  checkAndIncrementQuota,
  connectionCount,
  effectivePlan,
  getActiveSubscription,
  requireBankConnectionSlot,
  requireFeature,
  requireHouseholdSeat,
} from '../../src/auth/entitlements.js';
import { pool, resetDb } from '../setup/test-db.js';

/**
 * 0.15.0 — entitlement core. No routes wired yet; pure helpers.
 *
 * These tests exercise the gating primitives directly: plan
 * resolution, feature membership, bank-connection caps, household
 * seat caps, and per-period quota metering with overage rollback.
 */

async function defaultTenantId(): Promise<string> {
  const t = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
  );
  return t.rows[0]!.id;
}

async function setSubscription(opts: {
  tenantId: string;
  plan: Plan;
  status: SubscriptionStatus;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: Date;
  trialEnd?: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO subscriptions
       (tenant_id, plan_id, status, current_period_end, trial_end,
        cancel_at_period_end)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       status = EXCLUDED.status,
       current_period_end = EXCLUDED.current_period_end,
       trial_end = EXCLUDED.trial_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at = now()`,
    [
      opts.tenantId,
      opts.plan,
      opts.status,
      opts.currentPeriodEnd ?? null,
      opts.trialEnd ?? null,
      opts.cancelAtPeriodEnd ?? false,
    ],
  );
}

describe('Entitlements (0.15.0)', () => {
  let tenantId: string;

  beforeAll(async () => {
    // Make sure migrations have applied and the Default tenant exists.
    await resetDb();
    tenantId = await defaultTenantId();
  });
  afterAll(async () => {
    // Leave the DB in a clean-ish state for adjacent suites.
    await pool.query('DELETE FROM subscriptions');
    await pool.query('DELETE FROM usage_counters');
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM subscriptions');
    await pool.query('DELETE FROM usage_counters');
  });

  // ── Plan resolution ─────────────────────────────────────────

  it('returns null effectivePlan when no subscription exists', async () => {
    expect(await effectivePlan(tenantId)).toBeNull();
    expect(await getActiveSubscription(tenantId)).toBeNull();
  });

  it('treats trialing status as fully entitled at the plan tier', async () => {
    await setSubscription({ tenantId, plan: 'plus', status: 'trialing' });
    expect(await effectivePlan(tenantId)).toBe('plus');
  });

  it('treats active status as fully entitled', async () => {
    await setSubscription({ tenantId, plan: 'family', status: 'active' });
    expect(await effectivePlan(tenantId)).toBe('family');
  });

  it('past_due with no current_period_end is lenient (returns plan)', async () => {
    // No period_end → we can't compute a grace deadline; leniency
    // until a webhook updates the row.
    await setSubscription({ tenantId, plan: 'plus', status: 'past_due' });
    expect(await effectivePlan(tenantId)).toBe('plus');
  });

  it('past_due WITHIN grace window stays entitled (0.15.4)', async () => {
    // current_period_end was 1 day ago — grace lasts
    // GRACE_DAYS_AFTER_PAST_DUE (3) days past that.
    const oneDayAgo = new Date(Date.now() - 86400_000);
    await setSubscription({
      tenantId,
      plan: 'plus',
      status: 'past_due',
      currentPeriodEnd: oneDayAgo,
    });
    expect(await effectivePlan(tenantId)).toBe('plus');
  });

  it('past_due PAST grace window is denied (0.15.4)', async () => {
    // current_period_end was grace+1 days ago → grace expired.
    const expiredMs =
      Date.now() - (GRACE_DAYS_AFTER_PAST_DUE + 1) * 86400_000;
    await setSubscription({
      tenantId,
      plan: 'plus',
      status: 'past_due',
      currentPeriodEnd: new Date(expiredMs),
    });
    expect(await effectivePlan(tenantId)).toBeNull();
  });

  it("canceled with cancel_at_period_end + future period_end stays entitled", async () => {
    const future = new Date(Date.now() + 86400_000); // tomorrow
    await setSubscription({
      tenantId,
      plan: 'plus',
      status: 'canceled',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: future,
    });
    expect(await effectivePlan(tenantId)).toBe('plus');
  });

  it("canceled past current_period_end is not entitled", async () => {
    const past = new Date(Date.now() - 86400_000);
    await setSubscription({
      tenantId,
      plan: 'plus',
      status: 'canceled',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: past,
    });
    expect(await effectivePlan(tenantId)).toBeNull();
  });

  it('incomplete / paused / unpaid statuses are not entitled', async () => {
    for (const status of ['incomplete', 'unpaid', 'paused'] as SubscriptionStatus[]) {
      await setSubscription({ tenantId, plan: 'plus', status });
      expect(await effectivePlan(tenantId)).toBeNull();
    }
  });

  // ── requireFeature ──────────────────────────────────────────

  it('starter is denied every premium feature', async () => {
    await setSubscription({ tenantId, plan: 'starter', status: 'active' });
    for (const feature of Object.values(FEATURES)) {
      const denial = await requireFeature(tenantId, feature);
      expect(denial).not.toBeNull();
      expect(denial!.status).toBe(402);
    }
  });

  it('plus has every plus feature and is denied family-only', async () => {
    await setSubscription({ tenantId, plan: 'plus', status: 'active' });
    expect(await requireFeature(tenantId, FEATURES.BANK_SYNC)).toBeNull();
    expect(await requireFeature(tenantId, FEATURES.AI_NORMALIZE)).toBeNull();
    expect(await requireFeature(tenantId, FEATURES.RECEIPT_OCR)).toBeNull();
    expect(await requireFeature(tenantId, FEATURES.ANOMALY_ALERTS)).toBeNull();
    expect(await requireFeature(tenantId, FEATURES.CRYPTO_REFRESH)).toBeNull();
    // Family-only.
    const denial = await requireFeature(tenantId, FEATURES.BILL_SPLITTING);
    expect(denial?.status).toBe(402);
  });

  it('family has every feature including family-only ones', async () => {
    await setSubscription({ tenantId, plan: 'family', status: 'active' });
    for (const feature of Object.values(FEATURES)) {
      expect(await requireFeature(tenantId, feature)).toBeNull();
    }
  });

  it('no subscription → 402 with "no active subscription" message', async () => {
    const denial = await requireFeature(tenantId, FEATURES.BANK_SYNC);
    expect(denial?.status).toBe(402);
    expect(denial?.error).toMatch(/no active subscription/i);
  });

  // ── Bank-connection cap ─────────────────────────────────────

  it('starter cannot add any bank connections', async () => {
    await setSubscription({ tenantId, plan: 'starter', status: 'active' });
    const denial = await requireBankConnectionSlot(tenantId);
    expect(denial?.status).toBe(402);
  });

  it('plus has a 10-connection cap', async () => {
    await setSubscription({ tenantId, plan: 'plus', status: 'active' });
    // No connections yet → granted.
    expect(await requireBankConnectionSlot(tenantId)).toBeNull();
    expect(PLAN_FEATURES.plus.bankConnectionCap).toBe(10);
  });

  it('family has a 25-connection cap', async () => {
    expect(PLAN_FEATURES.family.bankConnectionCap).toBe(25);
  });

  it('cap is enforced against the live count', async () => {
    await setSubscription({ tenantId, plan: 'plus', status: 'active' });
    // Seed 10 plaid_items to fill the cap.
    for (let i = 0; i < 10; i++) {
      await pool.query(
        `INSERT INTO plaid_items
           (tenant_id, plaid_item_id, access_token_encrypted)
         VALUES ($1, $2, 'encrypted-stub')`,
        [tenantId, `cap-test-${i}`],
      );
    }
    expect(await connectionCount(tenantId)).toBe(10);
    const denial = await requireBankConnectionSlot(tenantId);
    expect(denial?.status).toBe(402);
    expect(denial?.error).toMatch(/limit reached/i);
  });

  // ── Household seat cap ──────────────────────────────────────

  it('starter caps household at 1 member', async () => {
    await setSubscription({ tenantId, plan: 'starter', status: 'active' });
    // resetDb seeded 1 admin user already.
    const denial = await requireHouseholdSeat(tenantId);
    expect(denial?.status).toBe(402);
  });

  it('family allows up to 6 household members', async () => {
    await setSubscription({ tenantId, plan: 'family', status: 'active' });
    // 1 admin already from resetDb; can still add up to 5 more.
    expect(await requireHouseholdSeat(tenantId)).toBeNull();
  });

  // ── Quota metering ──────────────────────────────────────────

  it('unlimited quota (family) grants but still records usage', async () => {
    await setSubscription({ tenantId, plan: 'family', status: 'active' });
    const r = await checkAndIncrementQuota(tenantId, FEATURES.AI_ASSISTANT, 5);
    expect(r.granted).toBe(true);
    expect(r.cap).toBeNull();
    expect(r.remaining).toBeNull();
    const row = await pool.query<{ count: number }>(
      `SELECT count FROM usage_counters
        WHERE tenant_id = $1 AND feature_key = $2`,
      [tenantId, FEATURES.AI_ASSISTANT],
    );
    expect(Number(row.rows[0]!.count)).toBe(5);
  });

  it('plus quota grants up to the cap, then denies and rolls back', async () => {
    await setSubscription({ tenantId, plan: 'plus', status: 'active' });
    // Plus cap = 500. Burn 499.
    const first = await checkAndIncrementQuota(tenantId, FEATURES.AI_ASSISTANT, 499);
    expect(first.granted).toBe(true);
    expect(first.remaining).toBe(1);
    // 1 more = ok.
    const ok = await checkAndIncrementQuota(tenantId, FEATURES.AI_ASSISTANT, 1);
    expect(ok.granted).toBe(true);
    expect(ok.remaining).toBe(0);
    // 1 more = denied + counter NOT incremented past cap.
    const denied = await checkAndIncrementQuota(tenantId, FEATURES.AI_ASSISTANT, 1);
    expect(denied.granted).toBe(false);
    expect(denied.denial?.status).toBe(402);
    const row = await pool.query<{ count: number }>(
      `SELECT count FROM usage_counters
        WHERE tenant_id = $1 AND feature_key = $2`,
      [tenantId, FEATURES.AI_ASSISTANT],
    );
    expect(Number(row.rows[0]!.count)).toBe(500); // rolled back to cap
  });

  it('denies quota use when the feature itself is not on the plan', async () => {
    await setSubscription({ tenantId, plan: 'starter', status: 'active' });
    const r = await checkAndIncrementQuota(tenantId, FEATURES.AI_ASSISTANT, 1);
    expect(r.granted).toBe(false);
    expect(r.denial?.status).toBe(402);
    // No counter row created.
    const row = await pool.query(
      `SELECT 1 FROM usage_counters
        WHERE tenant_id = $1 AND feature_key = $2`,
      [tenantId, FEATURES.AI_ASSISTANT],
    );
    expect(row.rowCount).toBe(0);
  });

  it('OCR quota is independent of AI assistant quota', async () => {
    await setSubscription({ tenantId, plan: 'plus', status: 'active' });
    // Plus: OCR cap 200, AI assistant cap 500.
    const ocr = await checkAndIncrementQuota(tenantId, FEATURES.RECEIPT_OCR, 200);
    expect(ocr.granted).toBe(true);
    expect(ocr.remaining).toBe(0);
    // AI assistant counter untouched.
    const ai = await checkAndIncrementQuota(tenantId, FEATURES.AI_ASSISTANT, 1);
    expect(ai.granted).toBe(true);
    expect(ai.remaining).toBe(499);
  });
});
