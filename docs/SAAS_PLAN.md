# SmrtCash SaaS Plan

**Status:** approved 2026-05-23. Source of truth for the upcoming
SaaS pivot. Implementation tracked as slices `0.15.x`.

## Strategic posture

Full SaaS pivot. Self-hosted OSS will be sunsetted (see "Self-host
sunset" below). Competing directly with Monarch / YNAB / Copilot on
features and household design, not on privacy positioning.

**Existing pieces that need re-architecting for SaaS:**
- BYO Claude/Ollama keys → vendor-provided AI with per-tenant quotas
- OFX Direct Connect bank credentials stored in tenant's DB →
  vendor-held, isolated per tenant, encryption-at-rest via managed
  KMS (not a per-deployment env var)
- `ATTACHMENT_ENCRYPTION_KEY` env var → per-tenant key from KMS
- README / FEATURES / KNOWN_ISSUES — drop the self-host wedge

## Pricing (locked)

| | **Starter** | **Plus** | **Family** |
|---|---|---|---|
| **Annual** | **$59** ($4.92/mo) | **$99** ($8.25/mo) | **$149** ($12.42/mo) |
| **Monthly** | $7.99 | $13.99 | $19.99 |
| Trial | 14 days, no card | 14 days, no card | 14 days, no card |

Monthly carries a ~50% premium over annual — industry default; drives
annual lock-in.

**Pricing rationale** (anchored on competitor research 2026-05-23):
- Mid-market cluster is $95–$110/yr (Monarch $100, YNAB $109, Copilot $95).
  $99 Plus sits at the dense anchor.
- $59 Starter undercuts everyone except Banktivity Bronze + Moneydance
  one-time — gives a real trial-to-paid funnel for the cost-conscious
  solo buyer.
- $149 Family is meaningfully cheaper than 6× any competitor's single-
  user seat and leans into household design as the wedge (Simplifi /
  Copilot / Rocket Money are weak here).

## Feature gating (locked)

| Feature | Starter | Plus | Family |
|---|---|---|---|
| Unlimited accounts (manual + file import) | ✓ | ✓ | ✓ |
| Basic budgets + goals + bills + cash-flow | ✓ | ✓ | ✓ |
| Rules-based normalization | ✓ | ✓ | ✓ |
| Mobile PWA | ✓ | ✓ | ✓ |
| **Bank sync** (Plaid + OFX-DC + scheduled) | — | ✓ (cap 10 institutions) | ✓ (cap 25 institutions) |
| **AI normalize** (Claude / Ollama) | — | ✓ | ✓ |
| **AI assistant** | — | ✓ (cap 500 tool calls/mo) | ✓ unlimited |
| **Receipt OCR** (Claude vision) | — | ✓ (cap 200 receipts/mo) | ✓ unlimited |
| **Anomaly alerts** | — | ✓ | ✓ |
| **Tax-category + year-end reports** | — | ✓ | ✓ |
| **Calendar budget view** | — | ✓ | ✓ |
| **Crypto refresh + multi-currency** | — | ✓ | ✓ |
| **Retirement projections** | — | ✓ | ✓ |
| **Multi-tenant households** (admin/spouse/child) | 1 user | 1 user | up to 6 + per-account permissions |
| **Bill-splitting / shared expenses** | — | — | ✓ |
| Support | email best-effort | email <48h | priority + onboarding call |

**Bank-sync caps decision:** Plaid charges roughly $0.30–$0.60 per
connected account per month. A Plus user with 10 institutions ≈
$3–$6/mo at cost, leaving ~$5/mo gross margin on the $8.25/mo
amortized price — workable but not generous. Family at 25 institutions
≈ $7.50–$15/mo at cost on $12.42/mo amortized → margin gets thin;
acceptable only because Family is positioned as the "we're the right
choice for your household" upsell, not the volume tier. Re-evaluate
caps after first 100 paying customers when real distribution is
known.

**Why no bank-sync on Starter:** A single Starter customer connecting
10 institutions eats their entire LTV in Plaid fees in month one. The
delta between Starter and Plus is explicitly "manual budgeting
power-user" vs "wants bank sync."

**Quota enforcement:** AI assistant tool calls and OCR pages are
metered. Quotas reset on the subscription billing-period boundary.
Overage behavior: hard cap (HTTP 429 with upgrade CTA) — no surprise
charges.

## Self-host sunset (locked)

**Hard cutover, no migration path.**

- `0.14.x` is the final self-hostable line. Tag `v0.14.7` as
  `smrtcash-oss-final` once the SaaS branch diverges.
- README updated to remove self-host instructions when the SaaS
  branch ships.
- Existing self-hosters can fork. No data-migration tooling
  provided; data-portability export tooling (already shipped in
  0.13.0) is the upper bound of what we hand them.
- Cleanest engineering path; worst goodwill. We accept the
  trade-off.

## Implementation slices

Each slice is independently shippable. Estimated effort assumes
focused work sessions of ~2–3 hours each.

### 0.15.0 — Schema + entitlement core

- `server/src/db/migrations/030_subscriptions.sql`:
  - `subscriptions` (tenant_id PK, stripe_customer_id,
    stripe_subscription_id, plan_id, status, current_period_end,
    trial_end, cancel_at_period_end, created_at, updated_at)
  - `usage_counters` (tenant_id, period_start, period_end,
    feature_key, count) for AI assistant + OCR quotas
- `server/src/auth/entitlements.ts`:
  - `FEATURES` const + `PLAN_FEATURES` map (Starter / Plus / Family →
    feature set + numeric quotas)
  - `getActiveSubscription(tenantId)` → plan + status
  - `requireFeature(tenantId, FEATURE)` → null on grant, `{status,
    error}` on deny (mirrors existing rbac helpers)
  - `checkAndIncrementQuota(tenantId, FEATURE, n=1)` → atomic
    UPSERT into `usage_counters`; returns remaining; throws on
    exhaustion
  - `connectionCount(tenantId)` → live count of (OFX-DC connections
    + Plaid items) for bank-sync caps
- Cross-tenant tests don't need updating yet — entitlement is
  orthogonal to isolation.

### 0.15.1 — Stripe products + checkout + webhook

- Stripe dashboard: 3 products × 2 prices = 6 price objects.
  Document price IDs in `server/src/billing/plans.ts`.
- `POST /api/billing/checkout`: takes `priceId` + `tenantId`, returns
  Stripe Checkout session URL. 14-day trial, `payment_method_collection:
  'if_required'` so card capture is skipped on trial start.
- `POST /api/billing/webhook`: signature verify, handle
  `customer.subscription.created/updated/deleted`,
  `invoice.payment_succeeded/failed`. Idempotent (dedupe via
  `stripe_event_id` table).
- `GET /api/billing/portal`: returns Stripe Customer Portal URL.

### 0.15.2 — Feature-gate every premium route

Apply `requireFeature` to the routes whose features sit behind a
paywall:

| Route | Feature key |
|---|---|
| `/api/ofx-dc/*` (mutate paths) | `BANK_SYNC` + connectionCount cap |
| `/api/plaid/*` (link, exchange) | `BANK_SYNC` + connectionCount cap |
| `/api/auto-sync/run` | `BANK_SYNC` |
| `/api/normalize` | `AI_NORMALIZE` |
| `/api/holdings/refresh-prices/crypto` | `CRYPTO_REFRESH` |
| `/api/anomalies/*` | `ANOMALY_ALERTS` |
| `/api/tax-year/*` | `TAX_REPORTS` |
| `/api/calendar/*` | `CALENDAR_VIEW` |
| `/api/assistant/*` | `AI_ASSISTANT` + per-call quota |
| Attachment POST (OCR path only) | `RECEIPT_OCR` + per-receipt quota |
| `/api/projections/*` | `RETIREMENT_PROJECTIONS` |
| `/api/shares/*`, `/api/transaction-shares/*` | `BILL_SPLITTING` |
| `/api/exchange-rates`, `accounts.currency != USD` | `MULTI_CURRENCY` |
| `/api/tenants/:id/invitations` (when about to exceed plan seat count) | `HOUSEHOLD_SEATS` |

New test file: `tests/security/entitlements.test.ts` — for each
gated route, verify Starter session = 403/upgrade-required and
Plus/Family = 200.

### 0.15.3 — Web billing UI

- `web/src/pages/BillingPage.tsx`:
  - Current plan card with status pill (trial / active / past_due /
    canceling)
  - "Change plan" → plan-selector with Stripe Checkout redirect
  - "Manage payment" → Stripe Customer Portal redirect
  - Usage meters (AI tool calls used / cap, OCR receipts used / cap)
  - Trial countdown banner (sitewide, when trial_end < 5 days)
- Upgrade prompt component used on every locked feature page
  ("This is part of Plus — start your 14-day trial")
- Plan-selector embedded in signup flow

### 0.15.4 — Dunning + grace + cancellation UX

- 3-day grace window on `invoice.payment_failed` before features
  lock. Send dunning email at day 0 / 1 / 3.
- "Cancel at period end" vs "cancel immediately" — UI defaults to
  period-end.
- Downgrade behavior:
  - Plus → Starter: bank sync stops; existing imported data
    preserved
  - Family → Plus: extra household members lose write access
    (downgraded to read-only, not deleted)
  - Any → cancelled: 30-day read-only grace, then full export
    offered, then deletion
- Data-retention policy: 30 days post-cancel for full restore;
  90 days for export-only; deletion at 90 days.

### 0.15.5 — SaaS readiness

- New signup flow:
  - Email + password (Argon2id — keep existing) + email verification
  - Plan selection → Stripe Checkout (trial)
  - Tenant auto-provisioned on subscription creation
- Stripe tax: enable automatic tax in Checkout. EU VAT MOSS for
  international.
- Drop self-host docs:
  - Replace README with SaaS landing-equivalent content
  - Remove `docker-compose.yml` quick-start
  - `docs/QUICKSTART.md` becomes "Sign up at smrtcash.com"
  - `docs/ADMIN_GUIDE.md` reframed as operator runbook (internal)
- ToS + Privacy Policy stubs (real legal review required before
  launch).
- Move `ATTACHMENT_ENCRYPTION_KEY` from env var to per-tenant key
  in AWS KMS (or equivalent). One-shot migration script for any
  existing data.

## Out of scope (for the 0.15 pass)

These are real SaaS-launch concerns that need work but aren't
included in the 0.15 implementation slices:

- Native mobile apps (PWA is the launch story)
- SOC 2 Type II (probably needed within year 1; can launch without)
- PCI compliance (Stripe Checkout / Customer Portal keeps us in
  SAQ-A, the lightest scope)
- Affiliate / referral program
- Annual pre-pay discount above the structural ~50% off monthly
- Migration tooling for users coming from Monarch / YNAB / Mint
  (their CSV exports work with our existing import; documented as
  best-effort, no per-vendor mapping)
- Localization beyond en-US

## Open competitive questions to revisit

- Mobile app gap: does PWA hold against Monarch's native iOS/Android?
  Watch retention data; native may need to be a 2026-Q4 deliverable.
- Plaid alternatives: MX / Finicity / TrueLayer pricing varies.
  Re-evaluate vendor at 1,000 paying customers.
- Empower-style free dashboard as customer-acquisition loss leader:
  considered, rejected for launch. Revisit at 12 months if CAC is
  painful.

---

*Approved decisions; implementation slices are scoped but
unwritten. Next session can start at 0.15.0 (schema + entitlement
core) at any time.*
