# SmrtCash — Roadmap

## Vision

SmrtCash is a personal-finance manager in the spirit of Quicken and
Monarch, delivered as **SaaS**. Customers sign up, get a tenant,
pay via Stripe, and use the app at our URL. The single-container
Dockerfile remains in the repo (it's the dev-loop image, and it's
what the SaaS itself runs in production behind Nginx Proxy
Manager) but **self-hosting is not a marketed customer option** —
the business model is recurring SaaS revenue.

Two real moats vs every cloud competitor:

- **Per-tenant envelope encryption** (DEK wrapped by KEK,
  rotatable per tenant via `/system/tenants/:id/rotate-encryption-key`).
  Monarch, Simplifi, Empower, CountAbout, Rocket Money all use a
  single platform key.
- **Agentic AI assistant** — 17 audit-logged tools today. Monarch
  shipped a weak "Ask Monarch" chatbot in 2024; nobody else has
  AI that does work, not just answers.

The product is delivered in phases + slices. Each one produces a usable
application — nothing is "all or nothing."

| Phase / series | Theme | Status |
|---------------|-------|--------|
| 1 | Foundation & Import | ✅ Complete — 2026-05-22 |
| 2 | AI Transaction Normalization | ✅ Complete — 2026-05-22 |
| 3 | Receipts & Attachments | ✅ Complete — 2026-05-22 |
| 4 | Insights & Reconciliation | ✅ Complete — 2026-05-22 |
| 5 | Dockerization, Auth & Hardening | ✅ Complete — 2026-05-22 |
| 6 | Budgeting & Cash Flow | ✅ Complete — 2026-05-22 |
| 7 | Wealth & Net Worth | ✅ Complete — 2026-05-23 |
| 8 | Connectivity & Automation | ✅ Complete — 2026-05-23 |
| 9 | Mobile, Assistant & Experience | ✅ Complete — 2026-05-23 |
| 0.13.x | Post-Phase-9 backlog (taxes, anomalies, crypto, sharing, permissions) | ✅ Complete — 2026-05-23 |
| 0.14.x | Multi-tenant isolation hardening (72 dedicated tests) | ✅ Complete — 2026-05-23 |
| **0.15.x** | **SaaS pivot — Stripe billing, gating, dunning, operator readiness** | ✅ Complete — 2026-05-24 |
| **0.16.x** | **SaaS launch readiness — signup, password reset, per-tenant encryption** | ✅ Complete — 2026-05-24 |
| **0.17.x** | **Documentation refresh + HTML build pipeline** | ✅ Complete — 2026-05-24 (0.17.0) |
| **0.18.x** | **Competitive parity & depth — close gaps vs Monarch / Simplifi / YNAB / Rocket Money / Lunch Money / Empower** | ✅ Complete — 0.18.0…0.18.12 shipped 2026-05-24 |
| **0.19.x** | **Reconciliation, investment analysis, ops debt** | ✅ Complete — 2026-05-26 |
| **0.20.x** | **Agentic AI moat — proactive insights, staged actions, voice** | ✅ Complete — 2026-05-26 |
| **0.21.x** | **Universal customer asks competitors haven't delivered** | ✅ Complete — 2026-05-27 |
| **0.22.x** | **Production launch readiness — Stripe live, ToS, observability** | ✅ Complete — 2026-05-24 |
| **0.23.x** | **Scaling — vertical upgrade runbook + horizontal architecture (read replicas, multi-instance app, object-store attachments)** | 📋 Planned |

Legend: ✅ done · 🔜 next up · 📋 planned · 💡 backlog

---

## Product positioning

A competitive review of Monarch, Simplifi, Empower, Banktivity,
CountAbout, Rocket Money, Moneydance, YNAB and Lunch Money shaped
this roadmap. The conclusion:

- **Table-stakes features** (budgeting, categorization, recurring
  expenses, net worth, investment tracking, mobile access) must
  all arrive — they are expected of any serious money app. The
  0.1.x → 0.18.x series got us through them.
- **The SaaS pivot reframes the wedge.** Earlier roadmap copy
  leaned on "self-host OR SaaS" as a dual-deploy differentiator;
  that's no longer the pitch. SaaS-only means we compete on
  **what we do**, not where we run. Two real moats remain:

  - **Per-tenant envelope encryption.** Every other cloud PFM
    (Monarch, Simplifi, Empower, CountAbout, Rocket Money) uses
    one platform key. We give each tenant its own DEK wrapped
    by the platform KEK and ship a one-click rotation flow at
    `/system/tenants/:id/rotate-encryption-key`. A KEK leak
    doesn't expose any tenant's plaintext attachments.
  - **Agentic AI assistant.** 17 audit-logged tools today. The
    assistant doesn't just answer questions — it *does* things,
    and every write is reversible from the audit log. Monarch
    shipped a weak "Ask Monarch" chatbot in 2024; everyone else
    has nothing. The 0.20.x series doubles down on this.

- **Pricing.** We price below Monarch ($14.99/mo) and at parity
  with Simplifi ($5.99/mo, more limited). Annual at ~58% off
  monthly. The 0.22.0 slice (promoted from 0.19.0) shipped a
  visible "Save N%" badge on the annual tier to lead users there.

- **Mobile via PWA.** Responsive web, installable to phone, one
  codebase, no app stores. Native re-evaluated only if PWA
  retention story fails — listed in 0.21.x deferred items.

- **Bank connectivity.** File import (CSV/OFX/QFX/QIF), OFX
  Direct Connect, and Plaid all available. Plaid is the
  customer-default for the SaaS; the others remain for users
  whose banks don't support Plaid or who prefer manual control.

---

## Phase 1 — Foundation & Import ✅

**Goal:** Stand up the stack and reliably import real bank/credit-card exports.

Delivered: monorepo + PostgreSQL + migrations; Fastify/TypeScript API; CSV &
XLSX importer with Chase format auto-detection and generic column mapping;
duplicate detection; integer-cents money handling; React web app for accounts,
transactions and importing; a 95-test automated suite. Verified end-to-end
with 1,944 real transactions.

---

## Phase 2 — AI Transaction Normalization ✅

**Goal:** Turn messy bank descriptions into clean, categorized data.

Delivered:

- [x] Pluggable `TransactionNormalizer` interface
- [x] **Claude API** provider — Haiku 4.5, prompt-cached system prompt, structured outputs
- [x] **Ollama** provider — local model via HTTP, JSON-mode output, graceful parsing
- [x] **Rules** provider — deterministic baseline (the default; works offline with no setup)
- [x] Provider chosen by configuration (`AI_PROVIDER`)
- [x] Per-transaction output: cleaned merchant, category, confidence score, optional note
- [x] User-editable category taxonomy with seeded defaults
- [x] In-prompt batching (one API call per ~25 transactions)
- [x] Review-and-edit UI: status filter, inline category editing, manual edits preserved across re-runs
- [x] 42 additional automated tests covering each provider and the full pipeline

---

## Phase 3 — Receipts & Attachments ✅

**Goal:** Tie supporting documents to transactions for clarity at tax time.

Delivered:

- [x] Multipart upload route (`POST /api/transactions/:id/attachments`) with
      drag-and-drop and click-to-browse in the web UI
- [x] Multiple attachments per transaction; inline image preview, PDF icon
- [x] JPEG / PNG / WEBP / PDF allow-list; 25 MB per-file cap; 100 MB
      aggregate cap per request
- [x] Filesystem storage under `ATTACHMENTS_DIR` (defaults to
      `<repo>/data/attachments`); path-traversal hardened
- [x] Receipt OCR via a pluggable `OcrProvider` interface — Claude vision
      provider (`claude-haiku-4-5`) extracts amount / date / merchant /
      confidence; results compared against the transaction with a $0.50 /
      3-day match tolerance
- [x] Restart-safe sweep on server boot retries any attachment still at
      `ocr_status='pending'` (file missing → marked `failed`)
- [x] 18 additional automated tests (unit + integration + functional)
      plus a Playwright end-to-end spec

**Deferred to Phase 5:** encryption at rest, Docker volume mount for the
attachments directory.

---

## Phase 4 — Insights & Reconciliation ✅

**Goal:** Make the data answer real questions about your money.

Delivered:

- [x] **Transfer detection** — `POST /api/transfers/detect` pairs
      equal-opposite amounts across different accounts within 5 days; the
      Transfers page lists pairs and supports manual link / unlink; rows
      show a `↔ transfer` pill on the Transactions page
- [x] **True balance reconciliation** — opening balance + as-of date on
      every account; account balance = opening + activity from opening date;
      per-row running balance via SQL window function; **closes KI-01**
- [x] **Insights endpoints** — spending-by-category, monthly
      income-vs-expense, monthly net-worth-over-time; all exclude transfers
      where it matters
- [x] **Dashboard** — pie of spending by parent category, grouped bar of
      income vs expense, line of net worth over time (Recharts)
- [x] **Filtered CSV export** — `GET /api/transactions/export` honors all
      list filters plus optional date range; UTF-8, always-quoted cells,
      date-stamped filename

---

## Phase 5 — Dockerization, Auth & Hardening ✅

**Goal:** Ship the secure, self-contained container.

Delivered:

- [x] **Single-container Docker stack** — multi-stage Dockerfile builds the
      web bundle, builds the server, ships a minimal `node:22-alpine`
      runtime; the server serves API + SPA from one port. `docker compose
      up` brings up db + app together; both have healthchecks.
- [x] **Single-user authentication** — Argon2id password, signed
      httpOnly/sameSite=strict session cookie, first-boot "set your
      password" flow, full auth gate on `/api/*`. **Closes KI-03.**
- [x] **Attachment encryption at rest** — AES-256-GCM with
      `ATTACHMENT_ENCRYPTION_KEY`; v=0 plaintext files keep working for
      backward compatibility.
- [x] **Database encryption at rest** — documented via host-volume
      encryption (LUKS/BitLocker/FileVault/encrypted ZFS) in the admin
      guide; no in-app column encryption.
- [x] **Secrets via env**, **non-root `node` user**, **`tini` entrypoint**.
- [x] **HTTPS guidance** — Caddy reverse-proxy snippet + `COOKIE_SECURE`
      flag in the admin guide.
- [x] **Dependency vulnerability policy** — cadence, severity SLAs, and
      pinning approach in the admin guide.
- [x] **Backup & restore tooling** — `npm run backup` and `npm run restore`
      cover both database (pg_dump custom format) and attachments (tgz).
- [x] **Migrations ship in `dist/`** — Dockerfile copies SQL into the
      compiled output. **Closes KI-04.**

---

## Phase 6 — Budgeting & Cash Flow ✅

**Goal:** Match the everyday strengths of Monarch and Simplifi.

Delivered:

- [x] **Flex budgeting** — monthly per-category budgets plus one explicit
      flex-pool row that catches spending in non-budgeted categories
- [x] **Monthly budget-vs-actual** — `/api/budgets/actual` with the
      flex-pool calculation; transfers excluded; full UI with red-when-over
      progress bars
- [x] **Savings goals** — name + target + current + optional date,
      progress-capped server-side, full CRUD UI
- [x] **Bill reminders + upcoming-bills view** — bills and recurring
      income, mark-paid advances the next due date by frequency,
      dashboard tile showing the next 30 days
- [x] **Cash-flow forecast** — `/api/cash-flow` walks current net worth
      forward through every projected bill/income event, plotted as a
      90-day line chart on the dashboard

**Auto-detection of recurring charges is deferred** — the manual entry
path turned out to be plenty for a single-user instance, and auto-
detection wants its own phase to handle the false-positive UX properly.

---

## Phase 7 — Wealth & Net Worth ✅

**Goal:** Add the wealth-tracking depth of Empower and Banktivity.

Sliced into three releases:

- **7.0** ✅ — investment holdings (cost basis + mark-to-market) and
  manual asset/liability accounts (house, mortgage, etc.); net-worth
  chart on the dashboard now includes them
- **7.1** ✅ (released as 0.10.0) — multi-currency with exchange
  rates. `exchange_rates` table, `open.er-api.com` auto-refresh,
  per-account currency picker, dashboard sums into a global display
  currency.
- **7.2** ✅ (released as 0.10.1) — retirement / long-term goal
  projections. `retirement_projections` table, monthly-compound
  math, /retirement page with nominal+real curves and optional
  target line.

Phase 7 deliberately took a long detour through operator features
(multi-tenant + RBAC + SMTP + backups + monitoring + design refresh,
versions 0.7.4 → 0.9.5) before closing out 7.1 and 7.2. The operator
features were originally backlog items; bringing them forward turned
the app into a real household-shared deployment before the wealth-
projection extras landed.

---

## Phase 8 — Connectivity & Automation ✅

**Goal:** Offer all three ways to get data in — without forcing the cloud.

Sliced into four releases:

- **8.0** ✅ (released as 0.11.0) — extended file imports (OFX 1.x SGML,
  OFX 2.x XML, QFX, QIF) plus the pluggable `TransactionDataSource`
  layer that the rest of Phase 8 plugs into. Enables a clean
  migration off Quicken / Banktivity / Moneydance with no aggregator.
- **8.1** ✅ (released as 0.11.1) — **OFX Direct Connect**: pull
  transactions straight from banks that support the protocol, with
  no aggregator. New `ofx_dc_connections` table (credentials stored
  AES-256-GCM encrypted under `ATTACHMENT_ENCRYPTION_KEY`), OFX 1.x
  SGML request builder, `/api/ofx-dc/connections` CRUD + `/test` +
  `/sync` routes, web Connections page with Test / Sync now.
- **8.2** ✅ (released as 0.11.2) — **Plaid integration**,
  super-admin-gated via the `PLAID_ENABLED` setting and disabled
  by default. New `plaid_items` + `plaid_account_links` tables
  (access tokens AES-256-GCM encrypted), full
  link-token / public-token exchange / `/transactions/sync` /
  `/item/remove` flow, web Connections page extension that only
  renders when `/api/plaid/status` reports enabled=true and only
  loads Plaid's external Link widget on-demand.
- **8.3** ✅ (released as 0.11.3) — **scheduled background sync**.
  In-process 60s scheduler walks every enabled OFX-DC connection
  and active Plaid item; per-source cadence gate on `last_sync_at`
  so a 60s tick never floods banks. Settings: `AUTO_SYNC_ENABLED`
  + `AUTO_SYNC_FREQUENCY` (hourly/daily/weekly) + `AUTO_SYNC_TIME`,
  all super-only. Super-admin "Auto-sync" panel on /system with
  enable / cadence / "Run all syncs now" controls. Per-source
  failures isolated (one bad bank can't block the rest).
- **8.3** 📋 — **scheduled background sync** + auto-import. A
  per-tenant cadence calls `fetch()` on each enabled data source
  and runs the same dedup + persistence path.

---

## Phase 9 — Mobile, Assistant & Experience ✅

**Goal:** Make SmrtCash a pleasure to use anywhere.

Sliced into four releases:

- **9.0** ✅ (released as 0.12.0) — **Installable PWA**. Web app
  manifest, service worker (cache-first for built assets,
  network-only for `/api/*`, offline app-shell fallback), responsive
  CSS pass with a collapsible mobile drawer, install prompt that
  surfaces `beforeinstallprompt`, offline indicator pill. Same
  container — no second deployment.
- **9.1** ✅ (released as 0.12.1) — **AI financial assistant**.
  Multi-turn tool-use loop against Claude with 12 tools (8 read,
  4 write). Tenant-scoped on every call; every write tool calls
  `recordAudit()` so the super-admin audit log captures every
  change. Children blocked. Bulk operations hard-capped at 500.
  New /assistant chat page with inline tool-call chips so the
  user sees exactly what the assistant did.
- **9.2** ✅ (released as 0.12.2) — **Bill-splitting / shared
  expenses**. New `split_participants` + `transaction_shares` tables
  (tenant-scoped, sign convention preserved so totals never desync).
  Routes: participant CRUD, `PUT /api/transactions/:id/shares`,
  `POST /api/transaction-shares/:id/settle`, summary endpoint.
  New /sharing page (net balances + per-participant share list +
  settle toggle), 👥 button on every transaction row opens a modal
  with split-equally + manual allocation. Two new assistant tools
  (`share_summary`, `split_transaction`) so the AI can answer "who
  owes me?" and "split this dinner 4 ways" in natural language.
- **9.3** ✅ (released as 0.12.3) — **Calendar budget view**.
  Single new endpoint `GET /api/calendar/:month` returns per-day
  spend / income / txn-count plus bill-due-marker ids, monthly
  totals (spend, income, budget), and upcoming bills. New
  `/calendar` page renders a 7-column grid with intensity-based
  spending heatmap, bill-due markers, click-a-day drawer showing
  that day's transactions. Tenant-scoped. One new assistant
  read tool (`calendar_month_summary`) so the AI can answer
  "what does my May calendar look like?".

---

## Beyond — Backlog 💡

User asked to work through the backlog after Phase 9 closed. Active
backlog plan: ship five small releases (`0.13.0` → `0.13.4`), defer
native mobile.

- Multi-user / household mode with per-user permissions — ✅ **0.13.4** (per-account read/read_write tuning; 2026-05-23)
- Tax-category tagging and year-end reports — ✅ **0.13.1** (2026-05-23)
- Cryptocurrency tracking (Simplifi-style) — ✅ **0.13.3** + scheduled refresh ✅ **0.13.5** (2026-05-23)
- Non-AI rules engine for auto-categorization — ✅ **0.13.6** (auto-apply on import + tenant scope + enable/priority; 2026-05-23)
- Advanced cash-flow forecasting & spending-anomaly alerts — ✅ **0.13.2** (anomaly alerts; 2026-05-23)
- Native mobile apps — only if the PWA proves insufficient (**deferred**)
- Data export / portability tooling — ✅ **0.13.0** (2026-05-23)

---

## 0.14.x — Multi-tenant isolation hardening ✅

Five-slice audit + fix pass that produced 72 dedicated cross-tenant
isolation tests. Every domain route, aggregation, and read path was
verified to never return data from another tenant. Closed every
known issue at the end of the series.

- **0.14.0–0.14.4** ✅ — slice-by-slice isolation hardening across
  routes, RBAC, account access, aggregations, and shared-state
  surfaces.
- **0.14.5–0.14.7** ✅ — closed the original KI list (npm
  vulnerabilities, dedup heuristic, XLSX date parsing, Windows tar
  shell-out, project folder name).

---

## 0.15.x — SaaS pivot ✅

Layered Stripe billing + entitlement gating on top of the existing
single-tenant model. Each slice is independently shippable; cumulative
effect is "the same app, now sellable."

- **0.15.0** ✅ — schema (subscriptions, usage_counters,
  stripe_processed_events) + entitlement core (PLAN_FEATURES,
  requireFeature, checkAndIncrementQuota).
- **0.15.1** ✅ — Stripe Checkout + webhook handler (idempotent
  upserts), Customer Portal.
- **0.15.2** ✅ — wire entitlement gates into every premium route
  (bank sync, AI assistant, OCR, anomalies, crypto, retirement,
  bill splitting).
- **0.15.3** ✅ — /billing page (plan card, usage meters, trial
  countdown, plan picker, manage-billing button).
- **0.15.4** ✅ — past-due grace (3 days) + dunning emails on
  payment_failed + UpgradePrompt wired into gated pages +
  cap-overflow UX.
- **0.15.5** ✅ — SaaS operator readiness: `/api/health/saas`
  endpoint + HealthPage SaaS cards, automatic-tax env toggle,
  operator runbook, ToS + Privacy stubs.

---

## 0.16.x — SaaS launch readiness ✅

Closes the launch gaps: customers can self-serve from `/signup`,
recover their own passwords, and every customer's attachments are
encrypted under a per-tenant DEK with a super-admin rotation path.

- **0.16.0** ✅ — public signup + email verification.
  `POST /api/auth/signup` (gated by `PUBLIC_SIGNUP_ENABLED`),
  verification email with 24-hour token, tenant + admin
  membership provisioned on verify, anti-enumeration 202 response.
- **0.16.1** ✅ — super-admin **subscriptions console** at
  `/system/subscriptions`. Grant courtesy plans, sync from
  Stripe, force-cancel locally. Every action audit-logged.
- **0.16.2** ✅ — self-service password reset.
  `POST /api/auth/password-reset-request` (always 202),
  `POST /api/auth/password-reset-confirm` (validates new
  password, invalidates every existing session for the user).
- **0.16.3** ✅ — operator settings unification. Six previously
  env-only keys (Stripe secret/webhook, public base URL,
  automatic tax, signup gate, support URL) now editable from
  `/settings`. `STRIPE_SECRET_KEY` rotation hot-swaps the
  cached SDK client. New `SUPPORT_URL` surfaced as
  "Help & feature requests" in every sidebar + unauth page,
  defaulting to https://support.builditsmrt.com/.
- **0.16.4** ✅ — per-tenant attachment encryption.
  `tenant_encryption_keys` table, AES-256-GCM envelope (DEK
  wrapped by KEK), `POST /api/system/tenants/:id/rotate-encryption-key`
  + button on each tenant row. Legacy v0/v1 stay readable; v1
  upgrades to v2 on rotation.

---

## 0.17.x — Documentation refresh + HTML build ✅

Documentation caught up to v0.16 reality and a static HTML mirror
was added so the marketing site can serve docs directly from `main`
without a build pipeline.

- **0.17.0** ✅ — README + FEATURES + ROADMAP + INSTALLATION
  + KNOWN_ISSUES brought current; `scripts/build-docs-html.mjs`
  renders every `.md` to a self-contained HTML page via
  `marked`; `docs/html/index.html` + 17 per-doc pages
  committed; inline CSS + dark-mode + GitHub-style anchor
  links + internal `.md`→`.html` link rewriting.

---

## 0.18.x — Competitive parity & depth ✅

Competitive read after v0.17 surfaced specific moats competitors
own that SmrtCash hasn't yet contested. Each slice closes one
gap; ordering is by impact-per-day so the early wins compound.

The full strategic read lives in the project notes; the short
version of each slice is below.

### Where competitors lead us today

- **Monarch** — goal-tracking depth (target dates, linked
  contributions, visualized progress). We have
  `savings_goals` but it's not dashboard-visible.
- **Simplifi** — cash-flow forecast as the hero dashboard
  feature. We compute a 90-day forecast but don't lead with it.
- **Empower** — investment analysis: fee analyzer, asset
  allocation drift, Monte Carlo. We have holdings + projections;
  missing the analysis layer.
- **YNAB** — debt-payoff workflows (snowball / avalanche). We
  track loan/credit-card accounts but don't ship a payoff plan.
- **Rocket Money** — subscription cancellation help. We detect
  subscriptions; we don't help cancel them.
- **Lunch Money** — public API + developer audience. We have
  no tenant-user API keys.
- **Banktivity / Moneydance** — cleared/uncleared bank-statement
  reconciliation. We have reconciliation but not the
  per-transaction cleared toggle that power users want.

### Where SmrtCash already has moats (under-sold)

These are real and shipped — the work below is also to
DRAMATIZE them via UX + the marketing copy on the BITS site.

- **Self-host OR SaaS** — same code as both a single-container
  install and a hosted service. Nobody else offers both.
- **Pluggable AI provider** — Claude / Ollama (fully local) /
  rules-only. Local AI is unique among consumer finance apps.
- **Per-tenant envelope encryption** — DEK wrapped by KEK,
  rotatable. Competitors use a single platform key.
- **AI assistant with 17 audit-logged tools** — tool-use loop
  with visible audit trail, not just a chatbot.

### Planned slices (ordered by impact-per-day)

- **0.18.0** ✅ (released 2026-05-24) — **Cash-flow forecast
  as dashboard hero**. `/api/cash-flow` now returns a ±1σ
  confidence band derived from the last 90 days of non-transfer
  transaction volatility (band widens as `stddev × √days`),
  plus `milestones.day_30/60/90` projected-balance points.
  Dashboard promotes the chart to full-width hero placement
  with three milestone tiles, a zero-reference line for
  overdraft visibility, and the daily-volatility figure
  surfaced in the subtitle. Steals Simplifi's hero feature
  using data we already had.
- **0.18.1** ✅ (released 2026-05-24) — **Subscription
  cancellation help**. Four nullable fields on `bills`
  (`cancel_url`, `cancel_email_template`, `cancel_steps`,
  `cancel_notes`) surfaced through a "Cancel info" modal on
  the Bills page. Built-in library of ~28 common merchants
  (Netflix, NYT, gym memberships, etc.) auto-fills blank
  fields on click; the library notes the *real* friction
  for each (NYT's chat funnel, WSJ's phone number, Planet
  Fitness's in-person-only rule). Copy-to-clipboard on the
  URL and email body. Green dot on the action button means
  the bill is documented. We don't try to be the concierge
  (legal + ops moat); just remove the friction Rocket Money
  charges $9/month for.
- **0.18.2** ✅ (released 2026-05-24) — **Vendor attribution
  + auto-versioned footer**. Out-of-band fix surfaced during
  test-deploy review: sidebar version was a hand-typed
  `v0.17.25` string and never updated as releases shipped.
  Replaced with `__APP_VERSION__` injected by Vite from
  `web/package.json` at build time, plus a new
  `BrandTagline` component on the sidebar + auth pages that
  carries "Developed by BuildITSmrt, LLC." attribution.
- **0.18.3** ✅ (released 2026-05-24) — **Idle auto-logout +
  per-user timezone**. Out-of-band request from the test-deploy
  user. Two controls:
  - `WEB_INACTIVITY_TIMEOUT_MINUTES` (super-only setting): when
    >0, auto-logs-out browsers idle for that many minutes.
    Enforced client-side by a `useIdleTimeout` hook watching
    mouse/key/scroll/touch; value delivered via
    `/api/auth/me.web_settings`.
  - `users.timezone` (per-user, nullable IANA string): new
    "My profile" modal in the sidebar footer lets each user
    pick their zone. `format.ts` gains `formatDateTime` +
    `formatRelative` helpers that read from a module-level
    state set on auth, so future datetime renderings
    automatically respect the choice.
- **0.18.4** ✅ (released 2026-05-24) — **Public read-only API
  + per-user keys**. Personal-access-token auth layered on the
  existing session-cookie path. New `api_keys` table (token
  hashed, prefix kept for display); `Authorization: Bearer
  smrt_…` works on every read endpoint; non-GET requests are
  blocked when via=apikey so a leaked token can't mutate.
  10-key per-user cap, audit-logged create/revoke, full
  cross-tenant isolation (Bearer minted under tenant A can't
  see tenant B). New `docs/PUBLIC_API.md` with curl
  examples. 6 new tests; 92 tenant + auth tests pass.
  (~2–3 days). Each tenant member gets an API key for their
  own data. Existing routes already RBAC-enforce ownership;
  this is a thin token-auth layer on top. Devs are an
  underserved beachhead market (Lunch Money's whole audience).
- **0.18.5** ✅ (released 2026-05-24) — **Goal tracking polish**.
  Migration 046 adds `goal_contributions` audit table. New
  Contribute button + modal on each goal card writes a signed
  audit row and bumps the goal's current. Goal cards show
  pace-needed ("$420/month needed") when both target date and
  remaining are set; progress bar turns green at 100%. Dashboard
  gains a "Top savings goals" tile (top 3, progress bar + target
  date). Transaction-tagging deferred to a future slice.
- **0.18.6** ✅ (released 2026-05-24) — **Debt payoff plans**.
  Migration 047 adds `interest_rate_apr` + `min_payment_cents`
  to `accounts`. New `POST /api/debt/payoff` runs snowball +
  avalanche calculators (capped at 600 months, flags
  unpayable). New `/debt-payoff` page with inline editors,
  extra-payment input, tab strip between strategies, and per-
  account result table.
- **0.18.7** ✅ (released 2026-05-24) — **Branded HTML email
  shell**. New `renderEmailShell({title, intro, ctaText,
  ctaUrl, bodyHtmlSafe, ctaColor})` in `domain/mailer.ts` —
  a 560px inline-styled table with navy BITS header, branded
  CTA button, monospace URL fallback, BuildITSmrt footer link.
  All four renderers (verification, password reset, invitation,
  dunning) now route through it. New `email-shell.test.ts`
  asserts each renderer's html contains the footer marker so
  a future contributor can't ship a hand-rolled email.
- **0.18.8** ✅ (released 2026-05-24) — **Unify base URL
  settings**. New `PUBLIC_BASE_URL` setting replaces both
  `APP_BASE_URL` and `STRIPE_PUBLIC_BASE_URL`. Migration 048
  backfills from the existing rows (Stripe key first, then
  app key) and deletes them. New
  `server/src/domain/base-url.ts` with one shared
  `resolveBaseUrl()` helper used by every callsite (auth,
  billing, webhook, tenant invites, super-admin invites).
  Legacy env-var names still work as fallback so operators
  with old `.env` files keep working. 102 tests still pass.
- **0.18.9** ✅ (released as v0.18.9 2026-05-24) — **Form
  contrast fix** (out-of-band). Inputs without explicit
  `type=` attributes fell through to an older CSS rule that
  hardcoded white background → washed-out look in dark mode.
  Consolidated to one rule covering every input type +
  themed file-input + `::file-selector-button`.
- **0.18.10** ✅ (released as v0.18.10 2026-05-24) —
  **Dropdown lifecycle audit + defensive `<select>` fix**
  (out-of-band). Audited every popover; all already on the
  safe `mousedown` outside-click pattern. Dropped the CSS
  `transition` on `<select>:focus` as a guard against a
  Chromium bug.
- **0.18.11** ✅ (released 2026-05-24) — **SaaS deploy guide
  + runbook gaps**. New `docs/SAAS_DEPLOY.md` walking through
  NPM-fronted deploy on a fresh box (11 sections, with the
  Maileroo URL-mangling lesson called out). New runbook
  entry for "User stuck on verification gate" with the SQL
  one-liner + pre-0.17.3-vs-post behavior matrix.
- **0.18.12** ✅ (released 2026-05-24) — **Settings URL
  validation guardrails**. Server-side `validateUrlSetting()`
  runs every URL-typed key through `new URL()` at write
  time, rejects 400 with an actionable message. Catches the
  `@`-instead-of-`.` typo that consumed hours of debugging
  on the test deploy. Web: per-key URL hint inline below
  the input, Save button disabled while invalid. Bonus:
  styled the `.hint.warn` CSS class that 3 pre-existing
  call sites were using without any rule. 6 new unit tests.

### Positioning / marketing (non-code, runs in parallel)

These don't need a release version — they live on the BITS
site + sales copy. Listed here so they ship alongside the
features that justify them.

- **"Your data, your hardware, your AI"** landing page
  leaning into the dual-deploy + local-AI + per-tenant
  encryption stack. Screenshots from `/settings` (AI
  provider picker), `/system/overview` (Rotate key button),
  and the install docs side-by-side.
- **Publish the encryption design** — a short page describing
  the KEK / DEK envelope, rotation flow, and what a KEK leak
  *does and doesn't* expose. Security-curious users notice
  what competitors hide.
- **Lead all comparison copy with the dual-deploy story.**
  No competitor matches it; every other comparison axis
  (UX polish, feature depth) is one we're either catching up
  on or matching.

---

## 0.19.x — Reconciliation, investment analysis, ops debt ✅

Pulled forward the surviving deferred items from the 0.18.x
competitive read plus the operational-debt list that had been
parked in a "Beyond v0.19+" section. Ordering is by
impact-per-day so the early wins compound.

### Planned slices (ordered by impact-per-day)

- **0.19.0** ✅ — **Promoted to [0.22.0](#022x--production-launch-readiness-)**
  and shipped 2026-05-25. Visible "Save N%" badge on annual
  cards + monthly-equivalent subtitle on /billing. Per-plan
  discount (Plus 41%, Starter + Family 38%) computed from the
  actual price delta in `plans.ts`.
- **0.19.1** ✅ — **Bill negotiation assist** (~1 day). Same
  pattern as 0.18.1 (cancellation help) but for an adjacent
  category. For detected recurring utilities (electric, gas,
  water, internet, cell), surface the company's
  billing-dispute URL + a canned email template the user can
  copy. Seeded library at
  `server/src/domain/negotiation-library.ts` covering the
  big-N national providers; per-bill override fields on the
  existing bill row carry user-specific edits. Reuses the
  modal pattern from 0.18.1 — small additional code, large
  user-value lift.
- **0.19.2** ✅ — **Cleared / uncleared reconciliation**
  (~2–3 days). The Banktivity / Moneydance power-user gap.
  Adds `transactions.cleared_at timestamptz` (nullable). A
  new account-detail "Reconcile" workflow lets the user enter
  the statement's closing balance + date, walks through
  uncleared transactions in date order, and shows a running
  difference. When the difference hits zero, the user can
  commit (sets `cleared_at = statement_date` on the touched
  rows). Per-row cleared toggle on the Transactions table for
  ad-hoc marking. New "as-of cleared balance" available in
  the account balance API.
- **0.19.3** ✅ — **Investment analysis (Empower-class)**
  (~3–5 days). Three sub-features on the existing
  `holdings` + `retirement_projections` data:
  - **Fee analyzer** — accepts a per-holding `expense_ratio`
    field (% per year), surfaces total annual fee drag
    across the portfolio and the 30-year compounded
    opportunity cost.
  - **Asset allocation chart** — per-holding `asset_class`
    tag (stocks / bonds / cash / alts / real-estate), pie
    chart with the breakdown, deviation-from-target chart
    if the user sets a target allocation.
  - **Monte Carlo on retirement** — Monte Carlo over the
    existing retirement projection (10,000 trials, normal
    distribution around the assumed return ± stddev), shows
    the percentile fan (10th / 50th / 90th) instead of a
    single deterministic line.
- **0.19.4** ✅ — **Observability** (~2–3 days). Today the
  /health page covers process metrics; an external sink is
  the gap. This slice ships:
  - **Structured request logs** — JSON-line per HTTP request
    with `tenant_id`, `user_id`, `route`, `status`, `ms`,
    `req_id`. Pino has the format already; this just turns
    it on and documents the field set.
  - **Sentry-equivalent error tracking** — pluggable error
    sink with a Sentry adapter (free for a single-project
    deploy) and an env-var-disabled no-op default. Captures
    server-side exceptions + the React error boundary on
    the web side.
  - **Slow-query / slow-route alerts** — middleware logs any
    request > 1000ms or any pg query > 500ms with the SQL
    + bind values redacted. Optional SMTP digest (reuses
    the anomaly-alert pattern from 0.13.2).

---

## 0.20.x — Agentic AI moat ✅

The single biggest unexploited lever in this space. SmrtCash
already has 17 audit-logged tool calls in the assistant; no
competitor has more than a handful, and Monarch's 2024
"Ask Monarch" is the only one out there at all. This series
pushes the assistant from "answers questions" → "does the work"
→ "proactively flags and suggests."

Re-cast positioning: this is *the* differentiator post-pivot. We
don't compete on "your hardware" anymore — we compete on what
the assistant does on your behalf.

### Planned slices (ordered by impact-per-day)

- **0.20.0** ✅ — **Proactive insight cards on the dashboard**
  (~2–3 days). Every morning the assistant scans the prior
  24h + 30-day trends and surfaces 0–3 "noticed this" cards on
  the dashboard: an anomaly above the existing scanner
  threshold; a budget category trending to overspend by month-
  end; an unusual recurring charge; a goal whose pace has
  slipped. Each card includes a one-line *why* and a one-click
  action (snooze / take action / dismiss). The signals all
  already exist (anomalies 0.13.2, cash-flow forecast 0.18.0,
  goal pace 0.18.5) — this slice wraps them in AI-curated copy
  and dashboard placement. **Changes the perceptual feel of the
  product more than any other ~3-day slice.**
- **0.20.1** ✅ — **Multi-step staged actions in the assistant**
  (~2–3 days). Today the assistant fires one tool call at a
  time and changes are immediate. This slice adds a "stage,
  preview, commit" wrapper: the assistant proposes a diff
  ("Move $200 to emergency fund; create budget for Dining at
  $400; subscribe to weekly over-budget email"), the user
  reviews + clicks Apply, every change is audit-logged, and a
  single "undo this batch" button reverts the whole thing.
  Unlocks user trust for complex requests like "reorganize my
  budgets along Ramsey 50/30/20."
- **0.20.2** ✅ — **Voice-first PWA assistant** (~3–5 days). Shipped MVP using Web Speech API (Safari on-device, Chrome/Edge cloud-routed). Whisper.cpp WASM upgrade is a documented follow-up for strict on-device privacy across all browsers.
  Open the assistant on mobile, tap a mic icon, say "Log a $87
  Costco run, split 60/40 grocery/household." Whisper.cpp WASM
  for on-device speech-to-text (no audio leaves the phone),
  pipes the transcript into the existing assistant text path.
  Use case: hands-free logging while driving / shopping. No
  competitor can match this because they'd need device → their
  server → LLM → back; we run end-to-end on the user's
  device + our backend.

### Stretch / TBD

- **Agent that proactively reaches out via email** — weekly
  "here's what your money did this week" summary email
  composed by the assistant. Optional and off by default.
  Slice TBD; depends on 0.20.0 landing first to validate the
  insight-cards model.

---

## 0.21.x — Universal customer asks ✅

These were the loudest unmet asks on r/MonarchMoney, r/Simplifi,
the YNAB forums, and Empower reviews. None of the cloud PFM
competitors had shipped them at the time; that was our opening.
Shipped end-to-end on 2026-05-27.

### Shipped slices

- **0.21.0** ✅ — **Real tax export** (commit `edc9f4f`).
  New `mileage_log` table for IRS-compliant per-trip logging;
  `tax-schedule-c.ts` maps free-text `tax_category` labels onto
  Schedule C lines (exact-label, "Schedule C - Line N" prefix,
  keyword fallback). `/api/reports/tax-year/:year/schedule-c`
  JSON, `.txf` (TurboTax v042), and `/mileage.csv` endpoints.
  `/tax` page gains a Summary / Schedule C tab + Download TXF
  + Mileage CSV buttons; new `/mileage` page in Insights.
- **0.21.1** ✅ — **Refund / chargeback tracking** (commit
  `1869230`). `refund_status` lifecycle on transactions
  (`refund_pending → refunded | disputed | chargeback_initiated
  → closed`), with `refund_note` + `refund_updated_at`. UI: a
  ↩ pill in the description meta and a refund action that
  opens `RefundStatusModal`.
- **0.21.2** ✅ — **Receipt → warranty tracking** (commit
  `f3cf8ba`). `warranties` table (item / vendor / purchase +
  expiry dates / optional price / transaction + attachment
  backrefs). `/warranties` page with status filter and edit
  modal. Daily insights scanner emits a `warranty_expiring`
  card with escalating severity as the date approaches.
- **0.21.3** ✅ — **Non-traditional household models**
  (commit `eef8ddd`). Three new tables: `household_participants`
  (named people), `account_splits` (percentage allocation),
  `custody_periods` (date-ranged ownership). `/household` page
  manages all three plus a per-participant year-to-date rollup.
  Cross-tenant invites are deferred — the existing
  membership/role flow covers spouse/child cases.
- **0.21.4** ✅ — **Investment performance analysis** (commit
  `3064d53`). New `investment-performance.ts` domain: TWRR,
  IRR (Newton-Raphson with bisection fallback), annualize, and
  S&P 500 benchmark from a static yearly-return table.
  `/api/investments/performance` returns per-account + portfolio
  numbers; `/investments` page gains a Performance section.
  Caveat: beginning-of-period value is approximated from
  cumulative prior-balance transactions — precise historical
  TWRR needs daily holdings snapshots (follow-up).
- **0.21.5** ✅ — **Scenario cash-flow forecasting** (commit
  `c287400`). `/api/cash-flow` accepts `incomePct`,
  `expensePct`, and `oneTime` query params and returns both
  baseline and scenario series. New `/scenarios` page with
  sliders (50–200%), one-time event rows, and a baseline-vs-
  scenario chart in the Planning nav group.
- **0.21.6** ✅ — **Subscription cancellation queue, scoped
  down** (commit `a7f9b28`). After review of the original
  Playwright-automation plan, scope was reduced to a manual
  queue: `cancellation_queue` table with state machine
  (`queued → in_progress → done | couldnt | abandoned`), no
  vendor credentials, no outbound automation. `/cancellations`
  page with per-row state-transition buttons + monthly-savings
  rollup of completed rows.
- **0.21.7** ✅ — **Portable .smrtcash data export + importer**
  (commit `0c7de6b`). Renamed the user-facing extension to
  `.smrtcash` (still gzipped tar under the hood) and added
  `importTenantBundle()` to rehydrate categories (parents
  first), accounts, and transactions with FK remapping.
  `POST /api/portability/import` accepts multipart upload;
  workspace page gains an Import section. Budgets / bills /
  recurring_income / holdings / attachment file bodies are
  returned in `skipped` — known follow-up work.
- **0.21.8** ✅ — **Split Budgets into Monthly + Paycheck pages**
  (UX restructure). The single `/budgets` page that mixed the
  category-target table with the Paycheck-to-Paycheck plan
  cards is now two URLs: `/monthly-budget` (categories vs.
  month-to-date) and `/paycheck-budget` (plan / period cards
  with the wizard). Old `/budgets` URL redirects to
  `/monthly-budget` for compatibility. Nav under Planning
  shows two entries: **Monthly budget** + **Paycheck budget**.

### Verification

Per-slice walk-throughs are in
[docs/VERIFY_0.21.x.md](VERIFY_0.21.x.md) — set-up, click path,
expected outcome for each slice. Use that doc to confirm the
above shipped as designed before declaring the arc done.

### Stretch (deferred from this arc)

- **Cross-tenant invites** — was the third bullet of 0.21.3.
  Existing tenant-membership flow already covers spouse/child
  access; true cross-tenant linking deferred until there's a
  concrete use case.
- **Daily holdings snapshots** — needed for precise historical
  TWRR in 0.21.4.
- **Wide importer round-trip** — 0.21.7 covers categories /
  accounts / transactions. Budgets, bills, recurring_income,
  holdings, and attachment bodies still need importer work.
- **Subscription cancellation automation** — the original
  0.21.6 scope. Deferred pending legal review of the ToS /
  unauthorized-access exposure.

### Stretch / TBD

- **Bank connection reliability** — the #1 complaint on every
  cloud PFM is Plaid disconnects. Adding a "your bank
  disconnected; here's the one-click reconnect" flow surfaced
  in the dashboard would reduce the universal pain. Slice TBD
  pending Plaid usage in production.

---

## 0.22.x — Production launch readiness ✅

The series that gets us to a live, paying-customer production
deploy. Goal: **production deploy tomorrow.** Some items are
codeable slices, others are one-time operator workflows
captured as runbooks.

### Codeable slices

- **0.22.0** ✅ — **Annual-pre-pay discount badge**
  (~½ day). Promoted from 0.19.0. Visible "Save 41%" badge
  on the annual card on `/billing`, plus a subtitle framing
  the yearly price in monthly-equivalent terms. No pricing
  change, no Stripe change — pure presentation lift. Ships
  before launch so the conversion signal is live on day 1.
- **0.22.1** ✅ — **Live-mode Stripe configuration verifier**
  (~half day). A new `/system/saas-readiness` super-only
  panel checks: live-mode secret key present, live-mode
  webhook secret present, all 4 plan products + price
  lookup-keys resolvable in live mode, customer portal
  enabled, automatic-tax setting matches operator intent.
  Each check is green/red with a one-line "how to fix" link
  to STRIPE_SETUP.md. Prevents the most-common cause of
  "I switched to live and now everything 500s."
- **0.22.2** ✅ — **Pricing + landing copy polish** (~1 day).
  Review every customer-facing copy surface (login, signup,
  /billing, dunning, verification email, support footer) and
  reset for paid SaaS:
  - Drop any remaining "self-host" mentions from customer
    surfaces (the dev/operator docs keep their detail).
  - Re-cast the value prop on /billing as "AI that does the
    work + encryption your provider can't see into."
  - Show pricing in monthly-equivalent next to annual to
    pair with the 0.22.0 badge.

### Operational runbooks (no slice, but tracked)

These get checked off in the launch playbook, not via a
version bump:

- **Provision production box** — fresh VPS, follow
  `docs/SAAS_DEPLOY.md` from 0.18.11. Separate from the
  test box; the test box stays for pre-prod verification.
- **DNS for production domain** — point the production
  domain (TBD with operator) at the new box's IP, A record
  + AAAA if IPv6 available. Cloudflare proxying optional.
- **NPM proxy host + Let's Encrypt** — same recipe as
  test box.
- **Stripe live-mode setup** — create live-mode products at
  agreed prices (or copy from test mode), capture the live
  `pk_live_*` + `sk_live_*` + `whsec_*` secrets, paste into
  `/settings`. The 0.22.1 verifier confirms.
- **SMTP relay sender-domain verification** for production
  domain (test box's verified domain doesn't transfer).
- **Bootstrap first super-admin** via
  `scripts/create-super-admin.mjs`.
- **Stripe Tax setup** if enabling automatic tax — Stripe
  → Settings → tax origin + per-jurisdiction
  registrations. Flag is wired; out-of-codebase work.

### Pre-launch sanity gates (must pass before announcing)

- ToS + Privacy stubs have *at minimum* a "draft — not yet
  reviewed by counsel" banner. Real lawyer review parked
  but blocked-on-launch is too strong; gate is "doesn't
  pretend to be reviewed."
- A test signup completes end-to-end: signup → verification
  email → click link → first-time UI → pick a plan →
  Checkout in live mode with a real card → returns to
  app → premium features unlocked → dunning email arrives
  for a forced payment failure.
- Webhook delivery verified live (Stripe dashboard shows
  ≥1 successful delivery to the production URL).
- Backups: `npm run backup` runs and produces both DB and
  attachment tarballs; restore tested into a scratch
  Postgres.

---

### Positioning / marketing (non-code, runs alongside 0.22.x)

- **Landing page** at the production domain leading with
  "AI personal finance that does the work" + the
  per-tenant-encryption + pricing pitch.
- **Comparison table** on the landing page: SmrtCash vs
  Monarch / Simplifi / Empower / Rocket Money on price,
  agentic AI count, encryption shape, multi-household
  model. Drop the "self-host" row that was in the old
  comparison copy.
- **Publish the encryption design** as a short page — the
  KEK/DEK envelope, rotation flow, what a KEK leak does
  and doesn't expose. Security-curious users notice what
  competitors hide.

---

### Deferred / external (no codeable slice)

- **ToS + Privacy lawyer review** — placeholder stubs ship
  with a "draft" banner; counsel review parked. Not a
  launch blocker per current decision, but every additional
  customer raises the cost of getting this wrong.
- **SOC 2 readiness** — eventually a B2B-grade SaaS needs
  this; not a launch blocker for individual consumers.
  Re-evaluate at 12 months / first enterprise interest.
- **Native mobile** — re-evaluate at 12 months. The PWA
  story has to fail (drop-off attributable to install/UX)
  before a native build earns its complexity.

---

## 0.23.x — Scaling 📋

**Goal:** Stop reaching for "stand up a new server" as the answer to "we're running out of capacity." Build the runbook for vertical upgrades and the architecture for horizontal scale so growth doesn't require an emergency migration.

The trigger for this series is the **/health → Server capacity** widget (0.18.13). Once that widget says "prepare a replacement environment by [date]," we want the migration to be a 1-hour boring procedure, not a project.

### 0.23.0 — Vertical-scale runbook ⬆️

Document and rehearse the cheapest answer to "we need more capacity": **bigger box.** Until traffic justifies the architectural complexity of horizontal scale, vertical is the right move.

Deliverables:
- `docs/RUNBOOK_VERTICAL_SCALE.md` — step-by-step for moving SmrtCash to a beefier VM with minimal downtime:
  - Pre-flight: take a backup (`scripts/backup.mjs`), confirm `health-capacity` projection vs. the new VM's capacity ceiling, schedule maintenance window.
  - Provision the new VM (CPU/RAM/disk sized to the next 12 months of projected growth + 50% headroom).
  - Sync: copy `/data` via rsync while the old box is still serving, then short maintenance window for final delta + DB freeze.
  - DNS swap via Cloudflare (low TTL ahead of time).
  - Verification: hit `/api/health`, walk a smoke checklist (login, dashboard, attach receipt, run scan, sync transactions, view Stripe portal).
  - Rollback: keep the old VM warm for 24h.
- **Reusable migration script** at `scripts/migrate-server.sh` that rolls those steps into one prompt-driven flow.
- **Capacity ceiling estimates** documented per Hostinger VM tier (or chosen host's equivalent) so the operator knows when the next-bigger tier still won't be enough.

Expected lifespan of vertical-only scaling: probably good through low-thousands of paying tenants. Beyond that → 0.23.1+.

### 0.23.1 — Stateless app + shared session store ↔️

Today the app is single-instance: one container, in-memory rate limit state, file-system attachments. Sharing instances behind a load balancer requires eliminating per-instance state.

Deliverables:
- **Redis (or Valkey) integration** for the rolling rate-limit counters (when F-01 lands those — see security audit), the OCR retry queue, and any short-lived process-bound state.
- **Sessions stay in Postgres** (already there — `sessions` table). No change needed; this slice is mostly about NOT introducing new instance-local state going forward.
- **Health-check endpoint** that returns 200 once the app is ready to accept traffic and 503 during startup migrations. Required for a load balancer to do anything sensible during deploys.
- **Multi-instance Docker compose** sample at `docker-compose.scale.yml` showing N app containers behind an Nginx LB on a single host — the "scale up before scale out" intermediate step.

### 0.23.2 — Attachments to object storage 📦

Today receipts live on the app's local filesystem encrypted with the per-tenant DEK. That's a hard ceiling on horizontal scale because every app instance needs the same files.

Deliverables:
- **S3-compatible client** (R2 / Backblaze B2 / Wasabi / actual AWS S3) behind a small adapter — the encryption layer stays in our process; the storage layer just gets a new backend.
- **Migration script** `scripts/migrate-attachments-to-s3.mjs` that walks `/data/attachments`, uploads each file as `<bucket>/<tenant_id>/<attachment_id>`, verifies the upload, then deletes the local file. Resumable.
- **Setting**: `ATTACHMENT_STORAGE=local|s3` with `S3_*` config keys. Defaults to `local` so self-host installs aren't surprised.
- **Backup script** updates: when `ATTACHMENT_STORAGE=s3`, backups skip the attachments tar and the operator relies on S3 lifecycle/versioning for that side.
- **F-31 hardening**: container can finally run with `read-only` rootfs since attachments no longer write to the local FS.

### 0.23.3 — Postgres read replica + connection pooling 📊

Once we're running N app instances, the DB becomes the next bottleneck. Two moves:

Deliverables:
- **PgBouncer** in front of Postgres (transaction-mode pooling) so app instances don't each consume a fan-out of long-held connections.
- **Read-replica routing** — a `pool.replicaQuery()` helper that targets a read-only Postgres replica for the dashboard, reports, and assistant read tools. Writes still go to the primary. Transparent to the rest of the codebase because we wrap the existing `pool.query()` with the replica choice at the call site.
- **Replica lag awareness** — if the replica is more than 30s behind, fall back to the primary so the user never sees stale data.
- **Documentation** at `docs/RUNBOOK_HORIZONTAL_SCALE.md` covering the cutover.

### 0.23.4 — Multi-region (optional, customer-driven) 🌎

Probably 2027+. Only worth doing once we have measurable EU/AU/AP customer base. Sketch only:
- Postgres logical replication across regions
- S3 cross-region replication (or per-region buckets)
- Latency-based DNS routing
- Per-region data residency for GDPR (revisit F-33's deferred-EU decision when we get here)

### What's deliberately out of scope (and why)

- **Sharding Postgres**. Useless at SmrtCash's scale and a constant complexity tax. Don't go there unless we see >100M txn rows per tenant (Personal Finance Lover's Million-Row Power User is a real edge case but not a planning constraint).
- **Microservices**. The monolith is right for this product. Splitting `assistant` or `billing` into separate services would multiply the deploy surface for no real isolation benefit — they all share the same tenant data anyway.
- **Server-side rendering**. The PWA model works for personal finance. SSR would add a node runtime in front of the static SPA assets for no measurable benefit.

---

## 0.24.x — Scenario expansion 📋

**Goal:** Turn `/scenarios` from a one-trick cash-flow projector into a real life-planning surface. Users come in with specific questions — "should I bump my 401(k)?", "what if we have a kid?", "is a balance transfer worth it?" — and walk out with a numeric answer they can lean on. Each scenario type is its own form + calculator + result panel under a shared hub UI.

### 0.24.0 — Scenario hub refactor 🧱

Refactor `/scenarios` into a hub that lists available scenario types and routes each to its own input/result view. The existing cash-flow-with-deltas scenario keeps working (becomes the "Cash-flow stress test" entry). Shared chrome (page header, history of saved scenarios, share-result link).

### 0.24.1 — Wealth-building scenarios 📈

- **Invest $X/mo for Y years at Z%** — compounding curve, tax-deferred vs taxable side-by-side, ending portfolio value.
- **Bump 401(k) to N%** — take-home delta this year, retirement balance delta at 65, employer-match capture.
- **Windfall split** — split a bonus / refund / inheritance between debt payoff, emergency fund, and invest; show 5/10/20-year impact of each split.
- **FIRE date** — given save rate + spend, project when the portfolio covers annual expenses at a 4% / 3% withdrawal.

### 0.24.2 — Debt-payoff scenarios 💸

- **Add $X/mo extra** — promotion of the existing /debt-payoff control into a saved/shareable scenario.
- **Balance transfer at N% APR for M months** — interest saved vs transfer fee, payoff date.
- **Consolidate at one rate** (HELOC / personal loan) — total cost + payoff date vs current trajectory.
- **Biweekly mortgage** — years shaved, interest saved, side-by-side schedule.

### 0.24.3 — Life-event scenarios 🌱

The most engaging category — users come for these.

- **Have a kid** — childcare/baby spend bump, 529 ramp, tax credit hit, 1-year and 5-year cash-flow impact.
- **Buy a house** — given target purchase price, model affordable mortgage from DTI + savings rate + current debt; show monthly payment, opportunity cost vs renting.
- **Job change** — salary delta, relocation cost, retirement-account portability, projected 5-year net-worth divergence.
- **Sabbatical / income loss** — emergency-fund runway, return-to-work recovery curve, what-it-costs to plan a 6-month break.
- **Recession** (income −X% for N months) — stress-test the next 24 months, where the budget breaks first.

### Implementation notes

Each scenario type lives in `web/src/scenarios/<type>/` with three exports: `<Type>Form`, `<Type>Calculator` (pure function, deterministic, no API), and `<Type>Result`. The hub maps a scenario id to those three. Server endpoints are only needed for scenarios that require historical data (e.g. baseline cash flow); the rest run client-side so they're snappy and shareable via URL params.

---

## 0.25.x — Credit score + retirement scenarios 📋

Deferred from 0.24.x because both need model layers we don't have yet.

### 0.25.0 — Credit-score modeling 📊

A coarse FICO-like model that translates utilization, age-of-credit, hard-pull count, and account mix into an estimated score band (not a number). Even with a simple "your utilization is 65% → band: Fair → likely 600-650" output, the scenario surface becomes:

- **Pay to N% utilization → score band** (pairs with the 0.22.2 credit-card payoff goals).
- **New card opened** — temp hit from hard pull + utilization headroom gained.
- **Old card closed** — utilization rises + average history shortens.
- **Collections removed** — biggest single-event modeled lift.

Open question for this arc: do we ship a hand-rolled model or buy a real score-estimator API (Experian, ScoreSense, etc.)?

### 0.25.1 — Retirement scenarios 🏖️

Once we have a real return-assumption model + withdrawal model:

- **Retire at 60 vs 65 vs 67** — savings needed, monthly draw, longevity risk.
- **Social Security at 62 vs 67 vs 70** — break-even age + lifetime delta.
- **Healthcare to Medicare gap** — premium projection for ages 60–65.
- **Roth conversion ladder** — convert $X/yr from traditional, tax cost vs RMD reduction at 73.

Depends on us having a real Monte Carlo or sequence-of-returns engine, not just compounding curves. Deferred until we know what we want there.

---

*This roadmap is a living document. Phase scope and ordering may shift as the
product is used and priorities become clearer.*
