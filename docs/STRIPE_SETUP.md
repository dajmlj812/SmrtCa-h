# Stripe setup for SmrtCash SaaS

One-time setup to get the Stripe side ready for the 0.15.x SaaS slices. After this you'll have:

- A Stripe account in test mode
- 3 products (Starter / Plus / Family) with 6 prices (monthly + annual each)
- API keys + webhook signing secret in `.env`
- The Stripe CLI forwarding webhooks to your local server

Estimated time: **15–20 minutes** if it's your first time, 5 if you've done this before.

---

## 1. Stripe account in test mode

Go to <https://dashboard.stripe.com/register> and create an account (or sign in to an existing one).

**Critically: stay in TEST MODE for development.** The toggle is in the top-right corner of the dashboard. Test mode uses fake card numbers, real-looking IDs, and doesn't bill anyone. The keys and price IDs you set up in test mode are entirely separate from live keys.

You can do all of this without entering business details. Stripe only forces you to "activate" your account when you want to accept real money. That's a later step (slice 0.15.5 or after).

---

## 2. Grab your API keys

Dashboard → **Developers → API keys** (left sidebar; if you don't see "Developers", click your account name top-left and toggle "Developer mode" on).

Copy these two keys:

| Key | Starts with | Where it goes |
|---|---|---|
| **Publishable key** | `pk_test_...` | `.env` → `STRIPE_PUBLISHABLE_KEY` |
| **Secret key** | `sk_test_...` | `.env` → `STRIPE_SECRET_KEY` |

The webhook signing secret is generated in step 5 below.

> **The secret key gives full account access.** Never commit it. `.env` is already in `.gitignore`; if you ever paste a `sk_live_...` in chat or a screenshot, rotate it immediately in the dashboard.

---

## 3. Create the 3 products

Dashboard → **Product catalog → Add product** (or directly: <https://dashboard.stripe.com/test/products/create>).

Create three products with these exact details. The `lookup_key` on each price is what our server code uses to find the price — keep them spelled exactly as shown.

### Product 1: SmrtCash Starter

| Field | Value |
|---|---|
| Name | `SmrtCash Starter` |
| Description | `Manual budgeting + file import. Unlimited accounts. No bank sync.` |
| Pricing model | Recurring |
| **Price 1 — monthly** | `$7.99 USD` / Monthly / **Lookup key:** `starter_monthly` |
| **Price 2 — annual** | `$59.00 USD` / Yearly / **Lookup key:** `starter_annual` |
| Free trial | (none on the price — handled in code) |

To add the second price, after saving the first one, click "Add another price" on the product detail page.

### Product 2: SmrtCash Plus

| Field | Value |
|---|---|
| Name | `SmrtCash Plus` |
| Description | `Everything in Starter, plus bank sync (10 institutions), AI assistant, receipt OCR, anomaly alerts, tax reports, crypto, multi-currency, retirement projections.` |
| Pricing model | Recurring |
| **Price 1 — monthly** | `$13.99 USD` / Monthly / **Lookup key:** `plus_monthly` |
| **Price 2 — annual** | `$99.00 USD` / Yearly / **Lookup key:** `plus_annual` |

### Product 3: SmrtCash Family

| Field | Value |
|---|---|
| Name | `SmrtCash Family` |
| Description | `Everything in Plus, plus up to 6 household members with per-account permissions, bill splitting, unlimited AI + OCR, 25-institution bank sync.` |
| Pricing model | Recurring |
| **Price 1 — monthly** | `$19.99 USD` / Monthly / **Lookup key:** `family_monthly` |
| **Price 2 — annual** | `$149.00 USD` / Yearly / **Lookup key:** `family_annual` |

After all three are created, the product catalog should show 3 products × 2 prices = 6 prices total.

**Why lookup keys instead of price IDs:** the actual price ID (`price_xxxxx`) differs between your test-mode account, your future live account, and anyone else who runs the code. The lookup key is stable — our `server/src/billing/plans.ts` will reference these by name (`starter_monthly` etc.) and the Stripe SDK resolves them per-account at runtime.

---

## 4. Install the Stripe CLI

Webhooks are how Stripe tells our server "a subscription was created/updated/canceled." In production they POST to a public URL. For local development, the Stripe CLI forwards real webhook events from your test-mode account to `localhost`.

### Windows (PowerShell)

```powershell
# Recommended: Scoop
scoop install stripe

# Or download the .exe from
# https://github.com/stripe/stripe-cli/releases/latest
```

### Mac

```sh
brew install stripe/stripe-cli/stripe
```

### Linux

See <https://docs.stripe.com/stripe-cli#install>.

Verify:

```sh
stripe --version
```

Should print something like `stripe version 1.x.x`.

---

## 5. Authenticate the CLI + start webhook forwarding

```sh
stripe login
```

This opens your browser to grant the CLI access to your Stripe test account. After approving, come back to the terminal — it'll print "Done!".

Now start the webhook listener. **Leave this running in a dedicated terminal** while you develop:

```sh
stripe listen --forward-to localhost:4000/api/billing/webhook
```

First time, it'll print something like:

```
> Ready! Your webhook signing secret is whsec_AbCdEf1234567890... (^C to quit)
```

**Copy that `whsec_...` value.** That's `STRIPE_WEBHOOK_SECRET` in `.env`.

This signing secret is **specific to the CLI's listen session**. Production will use a different one configured in the dashboard. For dev, this one stays valid as long as you've logged in once; you can stop and restart `stripe listen` without re-fetching it.

---

## 6. Add to `.env`

Open your `.env` (not `.env.example` — that's the template) and add:

```
# ── Stripe (0.15.x — SaaS billing) ───────────────────────────
STRIPE_SECRET_KEY=sk_test_...                 # from step 2
STRIPE_PUBLISHABLE_KEY=pk_test_...            # from step 2
STRIPE_WEBHOOK_SECRET=whsec_...               # from step 5
# Public origin used in Stripe Checkout success/cancel URLs.
# Local dev: http://localhost:5173 (Vite) or http://localhost:4000 (container).
STRIPE_PUBLIC_BASE_URL=http://localhost:4000
```

Restart the server (or the container) so the new env vars are picked up.

---

## 7. Smoke test the secret key

A quick check that your key works without writing any code:

```sh
stripe products list --limit 3
```

You should see your three new products listed. If you get `401 Unauthorized`, the key in `.env` is wrong or you're hitting live mode (re-check the `sk_test_` prefix).

---

## 8. Coming next

When the above is done, you have:

- Three test-mode products with stable lookup keys
- A running `stripe listen` session forwarding to `localhost:4000/api/billing/webhook`
- `.env` populated with secret + publishable + webhook signing keys

That unblocks slice **0.15.1 — Stripe products + Checkout + webhook**. Next session can:

1. Add `stripe` npm package to the server
2. Write `server/src/billing/stripe.ts` (lazy-init client; reads `STRIPE_SECRET_KEY`)
3. Write `server/src/billing/plans.ts` (lookup_key → plan_id map)
4. Add `POST /api/billing/checkout` — creates a Checkout session for a given lookup_key + tenant, returns the Stripe redirect URL
5. Add `POST /api/billing/webhook` — verifies signature, handles
   `customer.subscription.created/updated/deleted` and `invoice.payment_succeeded/failed`, idempotent via `stripe_processed_events`
6. Add `GET /api/billing/portal` — returns Stripe Customer Portal URL
7. Tests with `stripe.testHelpers.events.create` so we can simulate events without the CLI

---

## Common gotchas

- **"Customer Portal not configured"** when you call `/portal`. Dashboard → **Settings → Billing → Customer portal** — flip on Self-service. Configure return URL = your app URL. Do this once.
- **Trial doesn't apply** when a test card is added during Checkout. Our code uses `trial_period_days: 14` on the subscription create; verify the trial banner appears in Stripe's subscription view.
- **CLI prints "no such webhook endpoint"** when you try to trigger events via `stripe trigger`. You need `stripe listen` running in another terminal — the CLI creates an *ephemeral* endpoint pointed at your forward-URL when listen is active.
- **Idempotency on retries.** Stripe retries webhook delivery on 5xx for up to 3 days. Our handler dedupes by `event.id` via the `stripe_processed_events` table; never assume an event will be delivered exactly once.

---

## Live mode

Don't touch this until you're ready to launch. When that day comes:

1. Toggle the dashboard to **Live mode**.
2. Recreate the products with the same lookup keys (Stripe doesn't copy them across modes).
3. Get fresh `pk_live_...` + `sk_live_...` keys.
4. Configure a real webhook endpoint at `https://<your-domain>/api/billing/webhook` and grab the dashboard-issued signing secret.
5. Set the live-mode env vars on the production deployment ONLY. Never put `sk_live_` keys in dev `.env`.

This whole document also applies to a sandbox account on staging if you set one up.
