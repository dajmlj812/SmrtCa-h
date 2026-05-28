# SmrtCash — Feature List

Legend: ✅ available now · 🔜 next · 📋 planned · 💡 backlog (deferred)

The planned set was shaped by a competitive review of Monarch, Simplifi,
Empower, Banktivity, CountAbout, Rocket Money and Moneydance — adopting their
table-stakes features. As of **0.24.4**, every arc through 0.22.x (production
launch readiness) and 0.24.x (scenario expansion + matcher learning) is
complete. Native mobile is deferred (the PWA covers it). See the
[Roadmap](./ROADMAP.md) for phase detail and the [Changelog](../CHANGELOG.md)
for per-release notes.

---

## Accounts, signup, billing (SaaS — 0.15.x / 0.16.x)

| Feature | Status |
|---------|--------|
| Three pricing tiers — Starter / Plus / Family — with feature gating | ✅ |
| 14-day free trial via Stripe Checkout (no card required up front) | ✅ |
| Stripe Customer Portal — change plan, update card, cancel | ✅ |
| Dunning emails on `invoice.payment_failed` + 3-day grace window | ✅ |
| Past-due grace handling at the entitlement layer | ✅ |
| Per-tenant metered quotas (AI assistant, OCR) with cap-overflow warnings | ✅ |
| Bank-connection cap by tier (0 / 10 / 25) | ✅ |
| Public signup at `/signup` gated by `PUBLIC_SIGNUP_ENABLED` env | ✅ |
| Email verification on signup (anti-enumeration: 202 always) | ✅ |
| Self-service password reset with 1-hour token + session invalidation | ✅ |
| Super-admin **subscriptions console** — grant / sync from Stripe / force-cancel | ✅ |
| Super-admin **SaaS health dashboard** — tenants + subs + webhook ingest | ✅ |
| Runtime-editable Stripe keys + signup gate + support URL (no env-file edit) | ✅ |
| Operator-configured support / feature-request link on every page | ✅ |
| Stripe automatic tax toggle (env or `/settings`) | ✅ |
| Operator runbook covering webhook failures, customer triage, dunning, grace | ✅ |
| Stripe automatic-tax dashboard setup (US sales-tax / EU VAT MOSS) | 📋 outside the codebase |
| ToS + Privacy Policy lawyer review | 📋 before commercial launch |

## Security & encryption

| Feature | Status |
|---------|--------|
| Argon2id password hashing | ✅ |
| Signed HttpOnly session cookies, sameSite=Strict | ✅ |
| **Per-tenant envelope encryption** for attachments (DEK wrapped by KEK) | ✅ |
| Super-admin **rotate-encryption-key** button (re-encrypts every attachment) | ✅ |
| Legacy v0 (plaintext) and v1 (KEK-direct) attachments stay readable | ✅ |
| 72 dedicated cross-tenant isolation tests | ✅ |
| Cross-tenant attachment decryption fails GCM auth | ✅ |
| Audit log for every super-admin mutation | ✅ |
| Account enumeration prevented on signup + password reset | ✅ |
| Bring-your-own KMS for KEK | 💡 deferred — current env-var KEK works |

---

## Accounts

| Feature | Status |
|---------|--------|
| Create accounts with name, institution, last 4 digits | ✅ |
| Seven account types (checking, savings, credit card, cash, investment, loan, other) | ✅ |
| Per-account balance and transaction count | ✅ |
| Net-worth summary across all accounts | ✅ |
| Delete an account (cascades to its transactions) | ✅ |
| True balance reconciliation with opening balances | ✅ |
| Manual assets & liabilities (property, vehicles, loans) | ✅ |
| Multi-currency accounts with daily-refreshed FX rates | ✅ |

## Importing & Connectivity

| Feature | Status |
|---------|--------|
| Import CSV and Excel (`.xlsx` / `.xls`) files | ✅ |
| Auto-detect Chase credit-card and checking/savings layouts | ✅ |
| Generic column-mapping for any other bank | ✅ |
| Import preview, per-row error reporting, duplicate detection | ✅ |
| Import history (batches) per account | ✅ |
| OFX 1.x (SGML), OFX 2.x (XML), QFX, QIF import | ✅ |
| Pluggable account data-source layer | ✅ |
| OFX Direct Connect (direct bank protocol, no aggregator) | ✅ |
| Optional Plaid sync (opt-in cloud aggregation, super-admin-gated) | ✅ |
| Scheduled background sync (hourly / daily / weekly) | ✅ |
| Scheduled crypto price refresh (CoinGecko, once per day) | ✅ |

## Transactions

| Feature | Status |
|---------|--------|
| View, filter by account, full-text search, pagination | ✅ |
| Original bank description, memo, and source category preserved | ✅ |
| Money shown as exact currency, color-coded in/out | ✅ |
| AI-cleaned merchant names & categorization | ✅ |
| Manual edit / re-categorize | ✅ |
| Bulk edits with optional "save as rule" | ✅ |
| Bulk delete (with confirm) for cleanup | ✅ |
| Learned normalization rules (manual edits become persistent patterns) | ✅ |
| **Auto-learn from manual rename** — editing a transaction's merchant name auto-upserts a normalization rule so future imports of the same description carry the rename forward (0.24.10) | ✅ |
| Non-AI rules engine auto-applies during import (tenant-scoped, with enable/priority) | ✅ |
| Transaction splits (one transaction → multiple categories) | ✅ |
| Dedicated uncategorized review queue with inline categorization | ✅ |
| Transfer linking between your own accounts | ✅ |
| Recurring & subscription detection (AI-suggested, human-verified) | ✅ |
| Subscription action queue (flag → cancel / alter / keep with notes) | ✅ |
| AI subscription discovery (Claude-powered, filters out non-subscriptions) | ✅ |
| Receipt & file attachments | ✅ |

## Bill Matching & Recurring (0.22.x)

| Feature | Status |
|---------|--------|
| Unified `/recurring` page (Bills + Subscriptions, single sidebar entry) | ✅ |
| Per-bill **amount mode** — fixed (±$1/2%), drift (trailing-3mo avg ±10%), variable (absolute cap) | ✅ |
| Per-bill **merchant pattern** + match-window (default ±7 days) + overdue-grace (default 3 days) | ✅ |
| Auto-link incoming transactions to bills on import (vendor + date + amount fit) | ✅ |
| Triage queue when matcher isn't confident (ambiguous vendor, edge-of-window, out-of-tolerance) | ✅ |
| Daily overdue sweep — past-grace pending periods flip to overdue + emit an insight card | ✅ |
| **Drift-mode bills auto-track latest matched amount** — going-forward expected snaps to the last actual payment (0.24.10) | ✅ |
| Pause / Unpause bills indefinitely + Skip individual periods | ✅ |
| Rescan transactions — 90-day backfill matcher after editing match config | ✅ |
| Category fill-on-match — uncategorized transactions adopt the bill's category | ✅ |

## AI

| Feature | Status |
|---------|--------|
| Pluggable provider architecture (cloud or local) | ✅ |
| Claude API provider | ✅ |
| Local model provider (Ollama) | ✅ |
| Rules-only deterministic fallback | ✅ |
| Merchant cleanup & auto-categorization with confidence | ✅ |
| Comprehensive hierarchical category taxonomy (~190 categories) | ✅ |
| AI-suggested-category review (Approve / Merge / Reject) | ✅ |
| Receipt OCR matching | ✅ |
| Conversational AI financial assistant (17 tools, tenant-scoped, audit-logged) | ✅ |

## Budgeting & Cash Flow

| Feature | Status |
|---------|--------|
| Flex budgeting — fixed categories plus a variable-spending pool | ✅ |
| Budget periods — weekly / bi-weekly / semi-monthly / monthly / custom | ✅ |
| Monthly budget-vs-actual tracking | ✅ |
| Savings goals with progress tracking | ✅ |
| **Credit-card payoff goals** — track current balance toward $0 or N% utilization (default 30% for credit-score optimization); live progress from linked card balances; entry points on /goals AND /debt-payoff (0.22.2) | ✅ |
| **Goal templates** — 28 curated templates (emergency fund, debt payoff, 529, retirement, sabbatical, etc.) with sensible defaults | ✅ |
| Bill reminders & upcoming-bills view | ✅ |
| Simple cash-flow forecast from recurring items | ✅ |
| AutoMagic budget wizard (multi-period with bills/income/groceries/fuel/tolls) | ✅ |
| Vehicle-driven fuel cost calculator (EIA prices, ICE + EV) | ✅ |
| Toll-route weekly estimates | ✅ |
| Calendar budget view (per-day spend heatmap + bill markers) | ✅ |

## Wealth & Net Worth

| Feature | Status |
|---------|--------|
| Investment holdings — cost basis & mark-to-market | ✅ |
| Manual asset & liability tracking (house, mortgage, vehicle) | ✅ |
| Net worth over time across all accounts (incl. holdings + A&L) | ✅ |
| Multi-currency support with exchange rates | ✅ |
| Retirement / long-term goal projections | ✅ |
| Cryptocurrency holdings (mixed-asset accounts) | ✅ |
| CoinGecko price refresh (manual + scheduled) | ✅ |

## Insights & Reporting

| Feature | Status |
|---------|--------|
| Spending by category | ✅ |
| Income vs. expense trends | ✅ |
| Dashboard with charts | ✅ |
| Filtered CSV export | ✅ |
| Spending-anomaly alerts (large / unusual-at-merchant / duplicate-suspect) | ✅ |
| **Daily anomaly scan** — runs every ~23h per tenant, not just at import time (0.24.6) | ✅ |
| Tax-category tagging + year-end Schedule A / C reports (JSON + CSV) | ✅ |
| **Editable per-tenant IRS mileage rates** — was hardcoded, now per-year inline-editable on /mileage (0.24.5) | ✅ |
| Data portability (full `.smrtcash` export bundle, secrets stripped) | ✅ |
| Canned reports catalog — **17 reports** (CSV export per report) | ✅ |

### Canned reports (full list)

Core reports (0.13.x):

- Spending by category
- Top merchants
- Monthly income vs expense
- Subscription costs
- Largest transactions
- Net worth by month

Added in 0.24.4:

- **Year-over-year by category** — this period vs same period last year, with deltas and % change
- **Month-over-month movers** — biggest spending swings between the two most recent months
- **Day-of-week spending pattern** — total + count + average by weekday
- **Tax-deductible YTD** — Schedule C line totals (uses tax_category taxonomy)
- **Savings rate by month** — income, expenses, net, % saved
- **Income sources breakdown** — inflows grouped by category
- **First-time merchants** — vendors whose first transaction lands in the period (catches subscription creep)
- **Refunds and chargebacks YTD** — uses refund_status tracking
- **Bill price drift** — active bills whose recent payments deviate from the stated amount
- **Debt balance by month** — total debt across credit cards + loans + manual liabilities
- **Average transaction by category** — count, total, average per category

## What-if Scenarios (0.24.0–0.24.3)

`/scenarios` is a hub: pick a scenario type from the left rail, fill in
the form, see the result. Per-scenario inputs persist when switching so
users can compare answers. URL carries `?type=<id>` for refresh + sharing.

| Scenario | Category | Status |
|---------|----------|--------|
| Cash-flow stress test (income/expense %, one-time events) | Cash flow | ✅ |
| Invest $X/mo for Y years at Z% (tax-deferred vs taxable) | Wealth | ✅ |
| Bump 401(k) to N% (take-home impact + retirement balance impact) | Wealth | ✅ |
| Windfall split (emergency + debt + invest) | Wealth | ✅ |
| FIRE date (given save rate + spend) | Wealth | ✅ |
| Add $X/mo extra payment (time + interest saved) | Debt | ✅ |
| Balance transfer offer (promo APR + fee vs current) | Debt | ✅ |
| Consolidate at one rate (multi-debt rolled into one loan) | Debt | ✅ |
| Biweekly mortgage (years shaved + interest saved) | Debt | ✅ |
| Have a kid (childcare + 529 + tax credit; year 1 / 5 / 18) | Life event | ✅ |
| Buy a house (PITI + DTI + lender-comfort verdict) | Life event | ✅ |
| Job change (total comp delta adjusted for COL, N-year net) | Life event | ✅ |
| Sabbatical / income loss (runway + rebuild timeline) | Life event | ✅ |
| Recession / income shock (stress-test next year) | Life event | ✅ |
| Credit-score modeling (utilization → score band) | Credit | 📋 0.25.0 |
| Retirement (retire at 60/65/67, SS timing, Roth ladder) | Retirement | 📋 0.25.1 |

## Mobile & Experience

| Feature | Status |
|---------|--------|
| Installable PWA (responsive, mobile home-screen, offline shell) | ✅ |
| Bill-splitting / shared expenses (per-tenant participants, settle toggle) | ✅ |
| Calendar budget view | ✅ |
| Native mobile apps | 💡 deferred |

## Households & Sharing

| Feature | Status |
|---------|--------|
| Multi-tenant (one container, many households) | ✅ |
| Roles — admin / spouse / child | ✅ |
| Per-account read / read-write permission tuning | ✅ |
| Invitations & memberships (SMTP-deliverable) | ✅ |
| Super-admin audit log of every mutation | ✅ |
| **Cross-tenant data isolation verified end-to-end** (72 dedicated tests, 0.14.x) | ✅ |

## Data Integrity & Security

| Feature | Status |
|---------|--------|
| Money stored as integer cents — never floating point | ✅ |
| Parameterized SQL everywhere (injection-safe) | ✅ |
| Transactional, all-or-nothing imports | ✅ |
| ~630-test automated suite (unit → e2e) | ✅ |
| Live health dashboard (gauges, charts, CPU/mem/req-rate/DB-latency) | ✅ |
| GUI-managed backups (schedule + manual + retention) | ✅ |
| GUI-managed runtime settings (no .env edits for live config) | ✅ |
| Local-first — data stays in your PostgreSQL | ✅ |
| Argon2id authentication | ✅ |
| Encryption at rest (attachments & connection secrets AES-256-GCM; DB via host volume) | ✅ |
| Hardened Docker container | ✅ |
| Non-AI rules engine for auto-categorization (runs on import) | ✅ |
| Multi-tenant isolation — every read + write scoped to caller's tenant | ✅ |

---

## Platform

- **Web application** delivered as an installable PWA
- **Backend API** — Fastify + TypeScript
- **Database** — PostgreSQL 17 (runs as a Docker container)
- **Self-hosted** — runs entirely on hardware you control

See [ROADMAP.md](./ROADMAP.md) for the full phase plan and the longer-term
backlog, and [TESTING.md](./TESTING.md) for how the suite is verified.
