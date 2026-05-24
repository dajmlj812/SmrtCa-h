import type Stripe from 'stripe';
import { pool } from '../db/pool.js';
import type { Plan, SubscriptionStatus } from '../auth/entitlements.js';
import { renderDunningEmail, tryMail } from '../domain/mailer.js';
import { getEffectiveValue } from '../domain/settings.js';
import { getStripe } from './stripe.js';

/**
 * 0.15.1 — pure event-handler functions invoked by the webhook
 * route after signature verification + idempotency dedup.
 *
 * Why "pure" + separate from the route: testing. Each handler can
 * be exercised with a hand-built event payload + a real DB; no
 * HTTP setup, no signature signing. Routes are thin glue.
 *
 * Every handler is idempotent on its own (UPSERTs by tenant_id);
 * the `stripe_processed_events` table is belt-and-suspenders to
 * guarantee a given event.id is never applied twice even if
 * something else races us.
 */

const VALID_PLANS = new Set<Plan>(['starter', 'plus', 'family']);
const VALID_STATUSES = new Set<SubscriptionStatus>([
  'trialing', 'active', 'past_due', 'canceled',
  'incomplete', 'incomplete_expired', 'unpaid', 'paused',
]);

/**
 * Resolve `(tenant_id, plan)` from a Stripe subscription's metadata.
 *
 * Convention: the checkout route writes both onto the subscription
 * via `subscription_data.metadata`. Anything missing either field
 * (e.g. a subscription created in the dashboard by hand without
 * our metadata) is silently skipped — we don't want to corrupt the
 * DB with rows we can't tie to a tenant.
 */
function extractTenantAndPlan(
  sub: Stripe.Subscription,
): { tenantId: string; planId: Plan } | null {
  const tenantId = sub.metadata?.['tenant_id'];
  const planFromMeta = sub.metadata?.['smrtcash_plan'];
  if (!tenantId || typeof tenantId !== 'string') return null;
  if (!planFromMeta || !VALID_PLANS.has(planFromMeta as Plan)) return null;
  return { tenantId, planId: planFromMeta as Plan };
}

function timestampToDate(unix: number | null | undefined): Date | null {
  return typeof unix === 'number' ? new Date(unix * 1000) : null;
}

/**
 * As of Stripe API 2025-01-27.acacia, `current_period_end` moved
 * from the subscription to the subscription item. We have exactly
 * one item per subscription (single-product / single-price plans),
 * so the first item's value is the right one. The helper falls
 * back to a top-level field if a future SDK puts it back there or
 * if a webhook arrives from a pre-2025 account.
 */
function subscriptionPeriodEnd(sub: Stripe.Subscription): Date | null {
  const fromItem = sub.items?.data?.[0]?.current_period_end;
  if (typeof fromItem === 'number') return new Date(fromItem * 1000);
  const fromSub = (sub as unknown as { current_period_end?: number }).current_period_end;
  if (typeof fromSub === 'number') return new Date(fromSub * 1000);
  return null;
}

/**
 * `customer.subscription.created` and `customer.subscription.updated`
 * both UPSERT the row. Same shape — Stripe sends the full
 * subscription object in both events, so we don't care which fired.
 */
export async function handleSubscriptionUpsert(
  event: Stripe.Event,
): Promise<{ applied: boolean; reason?: string }> {
  const sub = event.data.object as Stripe.Subscription;
  const extracted = extractTenantAndPlan(sub);
  if (!extracted) {
    return { applied: false, reason: 'missing or invalid tenant_id/smrtcash_plan metadata' };
  }
  const status = sub.status as SubscriptionStatus;
  if (!VALID_STATUSES.has(status)) {
    return { applied: false, reason: `unknown subscription status "${status}"` };
  }
  const customerId =
    typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  await pool.query(
    `INSERT INTO subscriptions
       (tenant_id, stripe_customer_id, stripe_subscription_id,
        plan_id, status, trial_end, current_period_end,
        cancel_at_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       plan_id = EXCLUDED.plan_id,
       status = EXCLUDED.status,
       trial_end = EXCLUDED.trial_end,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at = now()`,
    [
      extracted.tenantId,
      customerId,
      sub.id,
      extracted.planId,
      status,
      timestampToDate(sub.trial_end),
      subscriptionPeriodEnd(sub),
      sub.cancel_at_period_end,
    ],
  );
  return { applied: true };
}

/**
 * `customer.subscription.deleted` flips the row to `canceled` so
 * the entitlement helpers' canceled-status logic takes over (which
 * checks `cancel_at_period_end` + `current_period_end` to honor the
 * "I paid for the month, let me finish it" case). We do NOT
 * physically delete the row — it's the historical record of the
 * tenant's last subscription.
 */
export async function handleSubscriptionDeleted(
  event: Stripe.Event,
): Promise<{ applied: boolean; reason?: string }> {
  const sub = event.data.object as Stripe.Subscription;
  // `subscription.deleted` events still carry the full sub object,
  // so we re-extract from metadata.
  const extracted = extractTenantAndPlan(sub);
  if (!extracted) {
    return { applied: false, reason: 'missing tenant_id metadata' };
  }
  await pool.query(
    `UPDATE subscriptions
        SET status = 'canceled',
            cancel_at_period_end = $1,
            current_period_end = $2,
            updated_at = now()
      WHERE tenant_id = $3`,
    [
      sub.cancel_at_period_end,
      subscriptionPeriodEnd(sub),
      extracted.tenantId,
    ],
  );
  return { applied: true };
}

/**
 * Invoice events.
 *
 * - `invoice.payment_succeeded` / `invoice.paid` — no state changes
 *   here; the `customer.subscription.updated` event arriving
 *   alongside carries the new `current_period_end`. Returning
 *   `applied:true` is just our "I've seen it, don't retry" signal.
 *
 * - `invoice.payment_failed` (0.15.4) — fire a dunning email
 *   pointing at /billing. Stripe also fires `customer.subscription.updated`
 *   right after (status → past_due) which the upsert handler
 *   captures separately. This handler doesn't touch the DB; it
 *   only sends mail.
 */
export async function handleInvoiceEvent(
  event: Stripe.Event,
): Promise<{ applied: boolean; reason?: string }> {
  if (event.type !== 'invoice.payment_failed') {
    return { applied: true };
  }
  const invoice = event.data.object as Stripe.Invoice;
  const customerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id;
  if (!customerId) return { applied: false, reason: 'no customer on invoice' };

  // Pull the customer's email from Stripe (Checkout-collected, may
  // differ from any local user email). Cheaper than joining through
  // memberships and gives the canonical billing contact.
  let customerEmail: string | null = null;
  let customerName: string | null = null;
  try {
    const c = await getStripe().customers.retrieve(customerId);
    if (!('deleted' in c) || c.deleted !== true) {
      customerEmail = (c as Stripe.Customer).email ?? null;
      customerName = (c as Stripe.Customer).name ?? null;
    }
  } catch {
    // Stripe down or customer deleted — skip the email rather than
    // failing the webhook. The next retry's webhook will try again.
    return { applied: false, reason: 'could not load Stripe customer' };
  }
  if (!customerEmail) {
    return { applied: false, reason: 'customer has no email on file' };
  }

  const baseUrl = ((await getEffectiveValue('STRIPE_PUBLIC_BASE_URL')) || 'http://localhost:4000')
    .replace(/\/+$/, '');
  const rendered = renderDunningEmail({
    customerName,
    billingUrl: `${baseUrl}/billing`,
    amountDueCents: invoice.amount_due ?? 0,
    currency: invoice.currency ?? 'usd',
  });

  const result = await tryMail({ to: customerEmail, ...rendered });
  // tryMail returns sent:false when SMTP isn't configured — that's
  // not a webhook failure, just a missing capability on this
  // deployment. Log it via the return so the webhook route's log
  // line records why mail didn't go out.
  return {
    applied: true,
    reason: result.sent ? undefined : `mail skipped: ${result.reason ?? 'unknown'}`,
  };
}
