# SmrtCash operator runbook

Practical playbooks for running SmrtCash as SaaS. Each section
gives the symptom, the first thing to check, and the recovery
steps. Aimed at the person on-call — terse on purpose.

If you only run SmrtCash for yourself (the self-host story is
unchanged), most of this is overkill; jump straight to the
"Customer reports they paid but can't access" + "Webhook
delivery is failing" sections, which are the ones a single
operator hits with real Stripe traffic.

---

## Quick reference

| Where to look                       | What it answers                                           |
| ----------------------------------- | --------------------------------------------------------- |
| `/health` page (super-admin)        | Process + DB + storage + **SaaS section** (0.15.5)        |
| Stripe Dashboard → Developers → Events | What Stripe thinks it sent us, deliveries, retries        |
| Stripe Dashboard → Customers        | Customer ↔ tenant lookup (search by email)                |
| `psql` `subscriptions` table        | What we believe about each tenant's plan + status         |
| `psql` `stripe_processed_events`    | Webhook ingest log (one row per delivered event_id)       |
| `psql` `usage_counters`             | AI / OCR usage per billing period                         |
| `scripts/inspect-subscriptions.mjs` | Pretty-print all subscription rows                        |
| `scripts/grant-saas-plan.mjs`       | Dev: grant a tenant a subscription bypassing Stripe       |

---

## Customer reports they paid but can't access features

Symptom: a tenant says they completed Stripe Checkout but a
gated page still shows the upgrade prompt.

1. **Find the tenant.**
   ```sql
   SELECT t.id, t.slug, t.name
     FROM tenants t
     JOIN memberships m ON m.tenant_id = t.id
     JOIN users u ON u.id = m.user_id
    WHERE u.email = '<customer@example.com>';
   ```
2. **Read our subscription row.**
   ```sql
   SELECT * FROM subscriptions WHERE tenant_id = '<id>';
   ```
   - Row missing → webhook never landed. Jump to "Webhook
     delivery is failing."
   - `status = 'incomplete'` → Checkout completed without a
     payment method (Stripe quirk). Have the customer open the
     Customer Portal from /billing and confirm a card.
   - `status = 'past_due'` and `current_period_end` was over 3
     days ago → grace expired (see entitlements.ts
     `GRACE_DAYS_AFTER_PAST_DUE`). Tell them to update the card;
     `customer.subscription.updated` on the retry will flip them
     back to `active` automatically.
3. **Cross-check against Stripe.** Search the dashboard by
   customer email or by the `stripe_customer_id` from our row.
   Look at the subscription's status, current period end, and
   the latest invoice. If Stripe says `active` and we say
   anything else, we missed an event — see "Reconciling a
   subscription state mismatch" below.
4. **Courtesy grant (only if you trust the customer's claim
   and Stripe is silent).** Run `scripts/grant-saas-plan.mjs` to
   write a row directly; this is a dev script, not production
   reconciliation. Prefer fixing the upstream missed webhook.

---

## Webhook delivery is failing

Symptom: `webhooks.processed_24h` on /health is zero or much
lower than usual; checkout completes but subscription rows
don't appear; customers report no access.

1. **Verify the receiver is alive.** From the server host:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H 'stripe-signature: nope' \
     -X POST https://<your-domain>/api/billing/webhook
   ```
   Expect `400` (invalid signature) — that proves the route is
   wired and reachable. `503` means `STRIPE_SECRET_KEY` or
   `STRIPE_WEBHOOK_SECRET` is unset in the runtime env. `5xx`
   anything else, check container logs.
2. **Check Stripe's delivery log.** Dashboard → Developers →
   Webhooks → your endpoint → "Recent events." Failed
   deliveries show HTTP status + body. A run of `400 Invalid
   signature` means the `STRIPE_WEBHOOK_SECRET` env var
   doesn't match the endpoint's signing secret — copy the
   correct one from the dashboard and restart the server.
3. **Replay missed events.** Stripe → event detail → "Send
   test webhook" or `stripe events resend <evt_id>` from the
   CLI. Our handler is idempotent (`stripe_processed_events`
   table) so re-applying a successful event is a no-op.
4. **If only a single event failed**: look at the response
   body Stripe captured. A handler crash will have logged at
   `level=error` with `eventId` + stack trace. Common culprit:
   a subscription created in the Stripe dashboard manually,
   without our `tenant_id`/`smrtcash_plan` metadata —
   `handleSubscriptionUpsert` returns `applied: false`,
   `reason: 'missing or invalid tenant_id/smrtcash_plan
   metadata'` and the row is intentionally skipped.

---

## Reconciling a subscription state mismatch

Symptom: Stripe says `active`, we say something else (or vice
versa). Usually caused by a dropped webhook delivery.

1. Find the canonical state in Stripe (dashboard → subscription
   detail). Note `status`, `current_period_end`, `cancel_at_period_end`,
   `trial_end`.
2. Find the most recent `customer.subscription.updated` event
   for that subscription in Stripe's event log.
3. Resend it: `stripe events resend <evt_id>`. Our webhook will
   UPSERT the row to match.
4. Verify with `scripts/inspect-subscriptions.mjs` or the
   `/health` SaaS section.
5. **Do not edit the row by hand** unless step 3 is impossible
   (event purged by Stripe retention). Hand-edits diverge from
   Stripe-as-source-of-truth and the next webhook will overwrite
   you anyway.

---

## SMTP outage / dunning emails not sending

Symptom: a customer's card failed but they didn't receive a
dunning email.

Dunning is best-effort: when SMTP isn't configured, the webhook
handler returns `applied: true, reason: 'mail skipped: SMTP not
configured…'` so Stripe still sees a 200 and stops retrying.
This is intentional — a deployment without SMTP shouldn't break
webhook ingest just because mail is missing.

To check:
1. /health page → no direct SMTP indicator; the Settings page
   has a Test button that exercises the same `tryMail()`
   plumbing.
2. Look in the server logs for `Webhook event accepted but not
   applied` with `reason: 'mail skipped: …'`. If you see those
   for `invoice.payment_failed` events, that's the smoking gun.
3. To recover: configure `SMTP_HOST` + `SMTP_FROM` in the
   Settings page (per-deployment runtime settings — no restart
   needed). The customer's next dunning email will go through;
   manually email the affected customers about the missed
   retry if you care.

---

## Past-due grace window math

When a payment fails:

1. Stripe → `invoice.payment_failed` → we send a dunning email,
   `customer.subscription.updated` arrives with `status =
   past_due`.
2. `effectivePlan(tenantId)` returns the plan for the next
   `GRACE_DAYS_AFTER_PAST_DUE` (3) days after
   `current_period_end`.
3. Stripe retries the card on its smart-retry schedule
   (default ~1d / 3d / 5d / 7d). A successful retry fires
   `customer.subscription.updated` with `status = active` and
   the next `current_period_end`. Grace is over; back to normal.
4. If all retries fail, Stripe fires
   `customer.subscription.deleted`. We flip the row to
   `canceled` and `effectivePlan` returns null.

To check a tenant's effective state right now: `psql` →
`SELECT status, current_period_end FROM subscriptions WHERE
tenant_id = '<id>';` and apply the rule in your head, or open
their `/billing` page in an impersonation cookie.

---

## How to grant courtesy access

If you owe a customer a free month (apology credit, contest
prize, etc.):

- **Preferred — apply via Stripe.** Add a one-off coupon /
  credit balance to the customer in the dashboard. Their next
  invoice will reflect it; the subscription row updates via
  the normal webhook path. This keeps Stripe as the source of
  truth.
- **Dev / emergency — direct DB grant.** `scripts/grant-saas-
  plan.mjs <tenant_slug> <plan> [days]` writes a subscription
  row with `status = 'active'` and `current_period_end` set to
  `now() + days`. **No `stripe_*` IDs are populated** — the
  customer cannot use the Customer Portal until they pass
  through Checkout once. Use sparingly.

---

## Stripe automatic tax

Off by default to keep dev / pre-launch deployments out of
"no tax origin address" errors. Flip on for production with:

```
STRIPE_AUTOMATIC_TAX=true
```

You also need a tax origin address configured in the Stripe
dashboard (Tax → Settings). For US sales tax this is enough;
for EU VAT MOSS you'll also need to enable Tax → Registrations
for each country you collect in.

---

## SaaS health page checklist (daily glance)

Open `/health` (super-admin) once a day during early launch:

- **Webhooks → Processed (24h)** — should match your rough
  expected delivery count (≥ one per active sub per day for
  invoice events, plus checkout traffic). A sudden drop is the
  first sign of a broken receiver.
- **Subscriptions → by_status** — `past_due` should be tiny
  (mostly clears within 3 days as cards retry); `canceled`
  drifts upward over time as customers churn. A sudden
  `past_due` spike means either a payment processor outage or
  a card-network event.
- **Tenants → With active subscription** vs **Total tenants**
  — your conversion ratio. Sudden divergence (lots of new
  tenants, no new subs) usually means a Checkout regression.

---

## Backups failing with EACCES on `/data/backups`

### Symptom
`POST /api/backups/run` (or the scheduled tick) returns / logs:
```
EACCES: permission denied, mkdir '/data/backups/2026-MM-DD_HH-MM-SS'
```

### Root cause
The app container runs as `node` (UID 1000) with `cap_drop: ALL`. The
`/data/backups` directory is a docker volume mount; if the volume was
just created (fresh stack, or after `docker compose down -v`) the host
path is owned by `root:root` and the container has no way to chown it
from inside — the dropped capabilities prevent it.

This has bitten us twice (prod cutover + a test redeploy). Boot-time
detection now logs a bordered banner to stderr when this happens
(`server/src/domain/backup-scheduler.ts` `checkBackupDirWritable`), so
`docker compose logs app` shows the fix in plain English.

### Fix
On the **docker host** (not inside the container):

```bash
# Resolve the volume's host path
HOST_DIR=$(docker volume inspect smrtcash_smrtcash-backups \
  --format "{{.Mountpoint}}")

# Chown to UID 1000 (the container's node user — different /etc/passwd
# name but same UID as the host's `ubuntu` on most distros).
chown -R 1000:1000 "$HOST_DIR"

# Verify
ls -la "$HOST_DIR"
```

### Verify the fix
```bash
# Trigger one backup; should write a fresh timestamped dir and return success.
docker exec smrtcash-app node -e "
import('./dist/domain/backup-runner.js').then(async (m) => {
  const r = await m.runBackup({ kind: 'manual' });
  console.log(JSON.stringify(r, null, 2));
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

Successful runs show `"status":"success"` and a non-zero `db_bytes`.
After the chown, the boot-time check on the next container restart
also goes quiet (success path is silent — only failures log).

### When this recurs
- After any `docker compose down -v` (volumes are destroyed + recreated)
- After a fresh stack provision on a new host
- After deleting + recreating a specific volume (`docker volume rm`)
- **Not** after plain `docker compose down` (volumes survive)
- **Not** after `docker compose up -d --build app` (no volume churn)

If the boot banner fires unexpectedly without a known volume reset,
check `docker volume ls` for stray sibling volumes (e.g.
`smrtcah_smrtcash-backups` from the `$h` path-name footgun — see
local-dev memory).

---

## Useful one-liners

```bash
# How many tenants, paying vs not
psql "$DATABASE_URL" -c \
  "SELECT COUNT(*) FILTER (WHERE s.status IN ('trialing','active','past_due')) AS paying,
          COUNT(*) AS total
     FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id;"

# Subscriptions in past_due (sorted by how long they've been there)
psql "$DATABASE_URL" -c \
  "SELECT tenant_id, plan_id, current_period_end
     FROM subscriptions WHERE status='past_due'
     ORDER BY current_period_end ASC;"

# Webhook events in the last hour (count by hour)
psql "$DATABASE_URL" -c \
  "SELECT date_trunc('hour', processed_at) AS hour, COUNT(*)
     FROM stripe_processed_events
     WHERE processed_at > now() - interval '24 hours'
     GROUP BY 1 ORDER BY 1 DESC;"
```

---

## User stuck on verification gate

Symptom: a user accepted an invitation (or signed up via OIDC,
or was created via the super-admin invite flow) and now can't
log in. The login screen rejects them with "Please confirm your
email address before logging in."

This is the pre-0.17.3 footgun. The 0.16.0 login gate refused
any user whose `users.email_verified_at` was NULL. Three
account-creation paths left that column NULL despite the path
itself being equivalent proof of email ownership:

- **Invitation acceptance** — clicking an invite link sent to
  the recipient's address IS the proof.
- **OIDC login** — the IdP already verified the address.
- **Super-admin invite** — the operator vouched explicitly.

v0.17.3 fixed the create paths so new users go straight to
`email_verified_at = now()`. Existing stuck users from earlier
deploys are unaffected by that fix and need this manual unstick:

```sql
UPDATE users SET email_verified_at = now()
  WHERE email_verified_at IS NULL
    AND id IN (
      SELECT user_id FROM memberships
      UNION
      SELECT user_id FROM user_identities WHERE provider != 'local'
    );
```

That covers everyone who has either a tenant membership (came
in through an invite) or a non-local identity (OIDC). It
deliberately does NOT touch users with only a `local` identity
and no memberships — those are `/signup` users who genuinely
should verify via email.

### Behavior matrix

| Created via | Pre-0.17.3 `email_verified_at` | Post-0.17.3 `email_verified_at` | Unstick? |
| --- | --- | --- | --- |
| Public `/signup` | NULL (waits for email click) | NULL (waits for email click) | No — this is correct |
| Email click on signup verification link | `now()` | `now()` | n/a |
| Accept invitation link | NULL ⚠️ | `now()` | Yes for pre-0.17.3 deploys |
| Super-admin invite | NULL ⚠️ | `now()` | Yes for pre-0.17.3 deploys |
| First OIDC login (auto-provision) | NULL ⚠️ | `now()` | Yes for pre-0.17.3 deploys |

If you've never been on a pre-0.17.3 deploy you can skip this
playbook entirely — there's nothing to fix.

---

## Related docs

- `docs/SAAS_DEPLOY.md` — fresh-box deploy walkthrough behind NPM
- `docs/SAAS_PLAN.md` — pricing tiers + feature gating (source of truth)
- `docs/STRIPE_SETUP.md` — initial Stripe configuration walkthrough
- `docs/TERMS_OF_SERVICE.md` — placeholder (legal review required before launch)
- `docs/PRIVACY_POLICY.md` — placeholder (legal review required before launch)
