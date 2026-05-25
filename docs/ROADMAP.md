# SmrtCash — Roadmap

## Vision

SmrtCash is a personal-finance manager in the spirit of Quicken and Monarch.
It is built to run **self-hosted** as a single Docker container on hardware
you control, **or as a SaaS** on infrastructure the operator deploys. The
self-host path stays first-class; the SaaS path layers Stripe billing,
public signup, and per-tenant encryption rotation on top of the same
single-tenant code.

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
| **0.18.x** | **Competitive parity & depth — close gaps vs Monarch / Simplifi / YNAB / Rocket Money / Lunch Money / Empower** | 🔜 In progress — 0.18.0 shipped 2026-05-24 |

Legend: ✅ done · 🔜 next up · 📋 planned · 💡 backlog

---

## Product positioning

A competitive review of Monarch, Simplifi, Empower, Banktivity, CountAbout,
Rocket Money, Moneydance and others shaped this roadmap. The conclusion:

- **Table-stakes features** (budgeting, categorization, recurring expenses,
  net worth, investment tracking, mobile access) must all arrive — they are
  expected of any serious money app.
- **But none of those competitors offer SmrtCash's wedge:** every cloud app
  (Monarch, Simplifi, Empower, CountAbout, Rocket Money) holds your data on
  *their* servers; the desktop apps (Banktivity, Moneydance) are closed and
  unextensible. **SmrtCash wins on privacy, data ownership, and your-own-AI.**

So the roadmap adopts the universal features but delivers them *without*
breaking the self-hosted model. Three direction-setting decisions:

- **Bank connectivity — offer all three options.** File import stays the
  always-available, fully-local baseline; OFX Direct Connect and an opt-in
  Plaid integration are added as *choices*, via a pluggable data-source layer
  (the same pattern as the pluggable AI normalizer).
- **Balanced focus** — build budgeting depth first (Phase 6), then wealth and
  net worth (Phase 7).
- **Mobile via an installable PWA** — responsive web, installable to a phone,
  one codebase, no app stores, still self-hosted.

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

## 0.18.x — Competitive parity & depth 📋

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
- **0.18.1** 📋 — **Subscription cancellation links** (~1–2
  days). For each detected subscription, store the
  cancellation URL + a canned email template + step-by-step
  instructions. Don't try to be the concierge (that's a
  legal + ops moat we won't build); just remove the friction
  Rocket Money charges for.
- **0.18.2** 📋 — **Public read-only API + per-user keys**
  (~2–3 days). Each tenant member gets an API key for their
  own data. Existing routes already RBAC-enforce ownership;
  this is a thin token-auth layer on top. Devs are an
  underserved beachhead market (Lunch Money's whole audience).
- **0.18.3** 📋 — **Goal tracking polish** (~2–3 days). Target
  dates with progress visualizations, contributions linked to
  specific transactions, dashboard card showing top goals.
  Existing `savings_goals` data; missing UX. Closes Monarch's
  visible advantage.
- **0.18.4** 📋 — **Debt payoff plans** (~2–3 days). For
  accounts of `type IN ('loan','credit_card')`, add a
  "Payoff plan" view with snowball + avalanche calculators
  and projected payoff date based on current min payment +
  optional extra. Closes the YNAB gap.
- **0.18.5** 📋 — **Branded HTML email shell + audit** (~1
  day). Every outward email already returns both `text` and
  `html` from its renderer (verification, password reset,
  dunning, tenant + super-admin invitations), but the HTML
  bodies are minimal and each renderer hand-codes its own
  styling. Slice goal: a shared HTML wrapper
  (`renderEmailShell({title, intro, ctaText, ctaUrl, body})`)
  with a consistent BITS header, button styling, and footer,
  used by all four renderers. Add a CI assertion that every
  `tryMail()` call site receives an `html` field so a future
  contributor can't ship a text-only email by accident.
  Driven by the test-deploy finding that operators want
  visually polished invitations, not raw monospace text.
- **0.18.6** 📋 — **Unify base URL settings** (~1 day).
  Currently there are two settings that answer the same
  question — "what URL should outgoing email links use?":
  `APP_BASE_URL` (read by tenant invitations and the
  super-admin admin-invite added in 0.17.1) and
  `STRIPE_PUBLIC_BASE_URL` (read by signup verification,
  password reset, dunning, and Stripe Checkout redirects).
  Their fallback orders differ. During the smrtcash-test
  deploy, an operator typo'd `APP_BASE_URL` with `@`
  instead of `.`; only the invitation flow broke (the
  signup-verification path was fine because it reads the
  other key). The bug was incredibly time-consuming to
  diagnose because the symptoms looked like SMTP-relay URL
  mangling. Slice goal: collapse both keys into a single
  `PUBLIC_BASE_URL`, migrate existing rows, replace all
  `resolveBaseUrl()` helpers with one. Prevents this exact
  category of "two settings, one source of truth, drift in
  between" bug.
- **0.18.7** 📋 — **SaaS deploy guide + runbook gaps** (~3
  hours, docs-only). Two artifacts left over from the
  smrtcash-test deploy:
  - **New `docs/SAAS_DEPLOY.md`** — step-by-step for putting
    SmrtCash behind Nginx Proxy Manager on a fresh box.
    Covers the actual sequence we ran:
    SSH preflight, deploy-key generation, `docker-compose.
    override.yml` for the `proxy` network (no host port
    publish), `.env` generation with strong secrets, NPM
    proxy-host config with the right advanced-tab snippet,
    SMTP relay choice (with the Maileroo URL-mangling
    lesson called out so future operators don't go on the
    same wild-goose chase), DNS verification, sandbox cleanup.
    The self-host single-container doc covers a developer's
    laptop — this covers a SaaS deploy.
  - **Operator runbook entry: "User stuck on verification
    gate"** — append to `docs/OPERATOR_RUNBOOK.md` with
    the SQL one-liner from 0.17.3's CHANGELOG and the
    pre-0.17.3 vs post-0.17.3 behavior matrix. Future
    operators upgrading from an older deploy will have a
    list of stuck users to unblock; this is the
    one-command fix.
- **0.18.8** 📋 — **Settings input validation guardrails**
  (~half day). The `@`-instead-of-`.` typo that consumed
  hours of diagnosis would have been caught instantly by
  client-side or server-side URL-shape validation on the
  settings page. Slice scope:
  - Server: every URL-typed setting key
    (`PUBLIC_BASE_URL`, `SUPPORT_URL`, `OLLAMA_BASE_URL`,
    `STRIPE_PUBLIC_BASE_URL` until 0.18.6 retires it)
    runs through `new URL(value)` at write time; reject
    400 + clear error message on parse failure.
  - Web: per-key input validation on `SettingsPage` —
    URL keys get a small "this doesn't look like a valid
    URL" hint inline before the Save button enables.
  - Bonus: visual warning when a URL host contains an `@`
    (RFC-allowed but almost always a typo of a `.`). The
    one-line check that would have saved this week's
    diagnosis time.

### Deeper bench (slice TBD)

These showed up in the competitive read but are heavier; they
may slip to v0.19+ depending on what early traffic asks for.

- **Investment analysis (Empower-class)** — fee analyzer
  (you have all the holdings; analyze expense ratios), asset
  allocation chart, Monte Carlo on the retirement projection.
- **Cleared / uncleared reconciliation (Banktivity-class)** —
  per-transaction cleared toggle + "reconcile against your
  statement" workflow with running difference.
- **Bill negotiation assist** — for detected recurring
  utilities, surface the company's billing-dispute URL +
  template. Same pattern as 0.18.1 but for an adjacent
  category.

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

## Beyond — v0.19+

Items deferred from earlier series that don't yet have a slice:

- **Stripe Tax dashboard setup** — enabling automatic tax
  requires Stripe Tax → Settings to be configured with a tax
  origin address (and country-by-country registrations for EU
  VAT MOSS). Out of the codebase; flag in `/settings` is wired.
- **ToS + Privacy lawyer review** — the placeholder stubs in
  `docs/TERMS_OF_SERVICE.md` and `docs/PRIVACY_POLICY.md` need
  jurisdiction-specific copy before commercial launch.
- **Observability** — structured request logs, Sentry-equivalent
  error tracking, slow-query / slow-route alerts. The /health
  page covers process metrics; an external sink is the gap.
- **Annual-pre-pay discount UX** — pricing already shows the
  yearly tier at a ~58% discount; a visible "Save 41%" badge
  on /billing would lift annual conversion.
- **Native mobile** — re-evaluate at 12 months if the PWA
  retention story isn't holding.

---

*This roadmap is a living document. Phase scope and ordering may shift as the
product is used and priorities become clearer.*
