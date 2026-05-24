import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import {
  handleSubscriptionDeleted,
  handleSubscriptionUpsert,
} from '../../src/billing/webhook-handlers.js';
import { pool, resetDb } from '../setup/test-db.js';

/**
 * 0.15.1 — pure-function tests for the webhook handlers. We
 * construct Stripe event payloads by hand (matching the SDK's
 * Event shape) and call the handler directly. No network. No
 * signature dance — that's tested at the route layer.
 */

async function defaultTenantId(): Promise<string> {
  const t = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
  );
  return t.rows[0]!.id;
}

function makeSubscription(opts: {
  id?: string;
  customer?: string;
  status?: Stripe.Subscription.Status;
  tenantId?: string;
  plan?: 'starter' | 'plus' | 'family';
  currentPeriodEnd?: number | null;
  trialEnd?: number | null;
  cancelAtPeriodEnd?: boolean;
}): Stripe.Subscription {
  const items: Partial<Stripe.SubscriptionItem>[] = [
    // Modern SDK puts current_period_end on the item, not the
    // subscription. We mirror that.
    {
      id: 'si_test_1',
      current_period_end: opts.currentPeriodEnd ?? 1_700_000_000,
    },
  ];
  const sub: Partial<Stripe.Subscription> & Record<string, unknown> = {
    id: opts.id ?? 'sub_test_abc',
    object: 'subscription',
    customer: opts.customer ?? 'cus_test_xyz',
    status: opts.status ?? 'active',
    trial_end: opts.trialEnd ?? null,
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    items: {
      object: 'list',
      data: items,
      has_more: false,
      url: '',
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
    metadata: {
      ...(opts.tenantId ? { tenant_id: opts.tenantId } : {}),
      ...(opts.plan ? { smrtcash_plan: opts.plan } : {}),
    },
  };
  return sub as Stripe.Subscription;
}

function makeEvent(
  type: Stripe.Event.Type,
  object: Stripe.Subscription,
): Stripe.Event {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    object: 'event',
    api_version: '2024-11-20.acacia',
    created: Math.floor(Date.now() / 1000),
    type,
    data: { object } as Stripe.Event.Data,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
  } as Stripe.Event;
}

describe('billing/webhook-handlers (0.15.1)', () => {
  let tenantId: string;

  beforeAll(async () => {
    await resetDb();
    tenantId = await defaultTenantId();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM subscriptions');
  });

  it('subscription.created UPSERTs a row from event metadata', async () => {
    const event = makeEvent(
      'customer.subscription.created',
      makeSubscription({
        tenantId,
        plan: 'plus',
        status: 'trialing',
        currentPeriodEnd: 1_700_000_000,
        trialEnd: 1_699_000_000,
        customer: 'cus_test_1',
        id: 'sub_test_1',
      }),
    );
    const r = await handleSubscriptionUpsert(event);
    expect(r.applied).toBe(true);

    const row = await pool.query<{
      plan_id: string;
      status: string;
      stripe_subscription_id: string;
      stripe_customer_id: string;
      current_period_end: Date | null;
      trial_end: Date | null;
      cancel_at_period_end: boolean;
    }>(
      `SELECT plan_id, status, stripe_subscription_id, stripe_customer_id,
              current_period_end, trial_end, cancel_at_period_end
         FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]).toMatchObject({
      plan_id: 'plus',
      status: 'trialing',
      stripe_subscription_id: 'sub_test_1',
      stripe_customer_id: 'cus_test_1',
      cancel_at_period_end: false,
    });
    expect(row.rows[0]!.current_period_end).toBeInstanceOf(Date);
    expect(row.rows[0]!.trial_end).toBeInstanceOf(Date);
  });

  it('subscription.updated UPSERTs over the same tenant_id row', async () => {
    const first = makeEvent(
      'customer.subscription.created',
      makeSubscription({ tenantId, plan: 'plus', status: 'trialing' }),
    );
    await handleSubscriptionUpsert(first);

    const second = makeEvent(
      'customer.subscription.updated',
      makeSubscription({
        tenantId,
        plan: 'family',
        status: 'active',
        cancelAtPeriodEnd: true,
      }),
    );
    const r = await handleSubscriptionUpsert(second);
    expect(r.applied).toBe(true);

    const row = await pool.query<{
      plan_id: string;
      status: string;
      cancel_at_period_end: boolean;
    }>(
      `SELECT plan_id, status, cancel_at_period_end
         FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(row.rows[0]).toEqual({
      plan_id: 'family',
      status: 'active',
      cancel_at_period_end: true,
    });
    // Still exactly one row — UPSERT, not insert.
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
  });

  it('subscription with missing tenant_id metadata is silently skipped', async () => {
    const event = makeEvent(
      'customer.subscription.created',
      makeSubscription({ plan: 'plus' }), // no tenantId
    );
    const r = await handleSubscriptionUpsert(event);
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/metadata/i);
    const rows = await pool.query(`SELECT 1 FROM subscriptions`);
    expect(rows.rowCount).toBe(0);
  });

  it('subscription with missing or invalid smrtcash_plan is silently skipped', async () => {
    const noPlan = makeEvent(
      'customer.subscription.created',
      makeSubscription({ tenantId }), // no plan
    );
    expect((await handleSubscriptionUpsert(noPlan)).applied).toBe(false);

    const junkPlan = makeEvent(
      'customer.subscription.created',
      makeSubscription({ tenantId, plan: 'enterprise' as 'family' }),
    );
    expect((await handleSubscriptionUpsert(junkPlan)).applied).toBe(false);
  });

  it('past_due status is recorded verbatim', async () => {
    await handleSubscriptionUpsert(
      makeEvent(
        'customer.subscription.updated',
        makeSubscription({ tenantId, plan: 'plus', status: 'past_due' }),
      ),
    );
    const r = await pool.query<{ status: string }>(
      `SELECT status FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(r.rows[0]!.status).toBe('past_due');
  });

  it('subscription.deleted flips an existing row to canceled', async () => {
    await handleSubscriptionUpsert(
      makeEvent(
        'customer.subscription.created',
        makeSubscription({ tenantId, plan: 'plus', status: 'active' }),
      ),
    );
    const event = makeEvent(
      'customer.subscription.deleted',
      makeSubscription({
        tenantId,
        plan: 'plus',
        status: 'canceled',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400, // 1 day from now
      }),
    );
    const r = await handleSubscriptionDeleted(event);
    expect(r.applied).toBe(true);

    const row = await pool.query<{
      status: string;
      cancel_at_period_end: boolean;
    }>(
      `SELECT status, cancel_at_period_end FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(row.rows[0]).toEqual({
      status: 'canceled',
      cancel_at_period_end: true,
    });
  });

  it('subscription.deleted on a tenant we don\'t recognize is a no-op (no insert)', async () => {
    const event = makeEvent(
      'customer.subscription.deleted',
      makeSubscription({ plan: 'plus' }), // no tenantId
    );
    const r = await handleSubscriptionDeleted(event);
    expect(r.applied).toBe(false);
    const rows = await pool.query(`SELECT 1 FROM subscriptions`);
    expect(rows.rowCount).toBe(0);
  });
});
