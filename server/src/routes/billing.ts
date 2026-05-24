import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { pool } from '../db/pool.js';
import { requireTenant } from '../auth/rbac.js';
import {
  FEATURES,
  PLAN_FEATURES,
  connectionCount,
  effectivePlan,
  getActiveSubscription,
  type Plan,
} from '../auth/entitlements.js';
import { automaticTaxEnabled, getStripe, isStripeConfigured } from '../billing/stripe.js';
import { isKnownLookupKey } from '../billing/plans.js';
import {
  handleSubscriptionUpsert,
  handleSubscriptionDeleted,
  handleInvoiceEvent,
} from '../billing/webhook-handlers.js';

/**
 * 0.15.1 — billing routes.
 *
 *   POST /api/billing/checkout   — create a Stripe Checkout session
 *                                  for the supplied lookup_key.
 *   POST /api/billing/webhook    — receive Stripe events. PUBLIC
 *                                  (signature-verified). Idempotent.
 *   GET  /api/billing/portal     — redirect URL to the Stripe
 *                                  Customer Portal for self-service.
 */

const TRIAL_PERIOD_DAYS = 14;

function publicBaseUrl(): string {
  return (process.env.STRIPE_PUBLIC_BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
}

/**
 * 0.15.3 — usage rollup for the current billing period. Looks up the
 * tenant's existing counters; null when no row exists yet (which is
 * indistinguishable from "0 used" for UI purposes).
 */
async function currentUsage(
  tenantId: string,
  featureKey: string,
): Promise<number> {
  const r = await pool.query<{ count: string }>(
    `SELECT count FROM usage_counters
      WHERE tenant_id = $1
        AND feature_key = $2
        AND period_end >= now()::date
      ORDER BY period_start DESC
      LIMIT 1`,
    [tenantId, featureKey],
  );
  return Number(r.rows[0]?.count ?? 0);
}

async function householdMemberCount(tenantId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM memberships WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(r.rows[0]?.c ?? 0);
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/billing/status ───────────────────────────────
  // Single endpoint powering the /billing page. Returns plan + state
  // + usage meters + caps, no Stripe IDs (those stay internal). Safe
  // for any authenticated tenant member to read — it's their own
  // tenant's billing state.
  app.get('/api/billing/status', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;

    const sub = await getActiveSubscription(tenantId);
    const plan = await effectivePlan(tenantId);
    const planDef = plan ? PLAN_FEATURES[plan] : null;

    // Usage on metered features. cap=null means unlimited (Family).
    const aiUsed = planDef ? await currentUsage(tenantId, FEATURES.AI_ASSISTANT) : 0;
    const ocrUsed = planDef ? await currentUsage(tenantId, FEATURES.RECEIPT_OCR) : 0;
    const aiCap = planDef?.quotas.aiAssistantToolCalls ?? null;
    const ocrCap = planDef?.quotas.receiptOcr ?? null;

    const bankUsed = await connectionCount(tenantId);
    const memberUsed = await householdMemberCount(tenantId);

    return {
      // null when no active subscription on this tenant — the UI
      // renders a "subscribe to a plan" card instead of usage meters.
      plan: plan ?? null,
      status: sub?.status ?? null,
      trialEnd: sub?.trialEnd?.toISOString() ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      // True when we have a Stripe customer on file — drives whether
      // the "Manage billing" button is enabled. Without a customer,
      // the only viable action is "Pick a plan" via Checkout.
      hasStripeCustomer: Boolean(sub?.stripeCustomerId),
      usage: {
        aiAssistant: {
          used: aiUsed,
          cap: aiCap,
          remaining: aiCap === null ? null : Math.max(0, aiCap - aiUsed),
        },
        receiptOcr: {
          used: ocrUsed,
          cap: ocrCap,
          remaining: ocrCap === null ? null : Math.max(0, ocrCap - ocrUsed),
        },
      },
      caps: {
        bankConnections: {
          used: bankUsed,
          cap: planDef?.bankConnectionCap ?? 0,
        },
        householdMembers: {
          used: memberUsed,
          cap: planDef?.householdMemberCap ?? 0,
        },
      },
    };
  });

  // ── POST /api/billing/checkout ────────────────────────────
  app.post('/api/billing/checkout', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isStripeConfigured()) {
      return reply.code(503).send({ error: 'Billing is not configured' });
    }
    const body = (req.body ?? {}) as { lookupKey?: unknown };
    const lookupKey = typeof body.lookupKey === 'string' ? body.lookupKey : '';
    if (!isKnownLookupKey(lookupKey)) {
      return reply.code(400).send({ error: 'Invalid lookupKey' });
    }

    const stripe = getStripe();

    // Resolve the Stripe price ID from the lookup_key. We don't
    // cache it locally because Stripe resolves it cheaply server-
    // side; one round trip per checkout is fine.
    const priceList = await stripe.prices.list({
      lookup_keys: [lookupKey],
      active: true,
      limit: 1,
    });
    const price = priceList.data[0];
    if (!price) {
      return reply.code(500).send({
        error:
          `Price for lookup_key "${lookupKey}" not found. Run ` +
          `scripts/stripe-setup.mjs to provision the catalog.`,
      });
    }

    // Reuse the tenant's existing customer if we have one; else
    // Stripe will create a fresh customer at checkout completion.
    const existing = await getActiveSubscription(tenantId);
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: [{ price: price.id, quantity: 1 }],
      // 14-day trial. `payment_method_collection: 'if_required'`
      // means we don't force a card on file at trial start —
      // standard SaaS-friendly trial UX.
      subscription_data: {
        trial_period_days: TRIAL_PERIOD_DAYS,
        // Metadata is the contract between checkout and webhook —
        // the webhook reads `tenant_id` + `smrtcash_plan` off the
        // resulting subscription to know who + which tier.
        metadata: {
          tenant_id: tenantId,
          smrtcash_plan: lookupKey.split('_')[0]!, // 'starter' | 'plus' | 'family'
        },
      },
      payment_method_collection: 'if_required',
      // Mirror tenant_id on the Checkout session itself so the
      // success page can verify ownership before showing receipt.
      metadata: { tenant_id: tenantId },
      success_url: `${publicBaseUrl()}/billing?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicBaseUrl()}/billing?status=canceled`,
      // 0.15.5 — env-driven via automaticTaxEnabled(). See
      // billing/stripe.ts for the rule + docs/OPERATOR_RUNBOOK.md
      // for the "before flipping this on" prerequisites.
      automatic_tax: { enabled: automaticTaxEnabled() },
    };
    if (existing?.stripeCustomerId) {
      sessionParams.customer = existing.stripeCustomerId;
    } else {
      // Prefill the email if we know the caller's identity.
      const userR = await pool.query<{ email: string }>(
        `SELECT email FROM users WHERE id = $1`,
        [req.user!.id],
      );
      const email = userR.rows[0]?.email;
      if (email) sessionParams.customer_email = email;
    }

    try {
      const session = await stripe.checkout.sessions.create(sessionParams);
      return { url: session.url, id: session.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, 'Stripe checkout.sessions.create failed');
      return reply.code(502).send({ error: `Checkout failed: ${msg}` });
    }
  });

  // ── POST /api/billing/webhook ─────────────────────────────
  // Public. Verified by HMAC signature. Idempotent via the
  // stripe_processed_events table.
  app.post('/api/billing/webhook', async (req, reply) => {
    if (!isStripeConfigured()) {
      return reply.code(503).send({ error: 'Billing is not configured' });
    }
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: 'STRIPE_WEBHOOK_SECRET not configured' });
    }
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string' || signature === '') {
      return reply.code(400).send({ error: 'Missing Stripe signature' });
    }
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      // app.ts sets rawBody via a custom JSON parser. If it's
      // missing here, the parser didn't register — operator error.
      return reply.code(500).send({ error: 'Raw body missing (parser misconfigured)' });
    }

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: `Invalid signature: ${msg}` });
    }

    // Idempotency: claim this event_id once. If another delivery
    // already inserted, return 200 silently — Stripe sees success
    // and stops retrying.
    const claim = await pool.query<{ event_id: string }>(
      `INSERT INTO stripe_processed_events (event_id)
       VALUES ($1) ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [event.id],
    );
    if (claim.rowCount === 0) {
      return { received: true, deduped: true };
    }

    try {
      let result: { applied: boolean; reason?: string };
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          result = await handleSubscriptionUpsert(event);
          break;
        case 'customer.subscription.deleted':
          result = await handleSubscriptionDeleted(event);
          break;
        case 'invoice.payment_succeeded':
        case 'invoice.payment_failed':
          result = await handleInvoiceEvent(event);
          break;
        default:
          // Unknown / unhandled type — return 200 so Stripe doesn't
          // retry. We've already recorded the event_id; future
          // analytics can walk the dedupe table to see what's
          // arriving.
          result = { applied: false, reason: 'unhandled event type' };
      }
      if (!result.applied && result.reason) {
        req.log.warn(
          { eventId: event.id, eventType: event.type, reason: result.reason },
          'Webhook event accepted but not applied',
        );
      }
      return { received: true, applied: result.applied };
    } catch (err) {
      // Roll back the idempotency claim so Stripe's retry CAN
      // re-attempt. Better to risk a duplicate than to drop the
      // event entirely.
      await pool.query(
        `DELETE FROM stripe_processed_events WHERE event_id = $1`,
        [event.id],
      );
      req.log.error(
        { err, eventId: event.id, eventType: event.type },
        'Webhook handler threw — rolled back idempotency claim',
      );
      return reply.code(500).send({ error: 'Handler failed' });
    }
  });

  // ── GET /api/billing/portal ───────────────────────────────
  app.get('/api/billing/portal', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isStripeConfigured()) {
      return reply.code(503).send({ error: 'Billing is not configured' });
    }
    const sub = await getActiveSubscription(tenantId);
    if (!sub || !sub.stripeCustomerId) {
      return reply.code(404).send({
        error: 'No subscription on this tenant — start one from /billing',
      });
    }
    try {
      const session = await getStripe().billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: `${publicBaseUrl()}/billing`,
      });
      return { url: session.url };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, 'Stripe billingPortal.sessions.create failed');
      return reply.code(502).send({ error: `Portal failed: ${msg}` });
    }
  });
}
