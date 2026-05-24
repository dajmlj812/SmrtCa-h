# SmrtCash — Feature List

Legend: ✅ available now · 🔜 next · 📋 planned · 💡 backlog (deferred)

The planned set was shaped by a competitive review of Monarch, Simplifi,
Empower, Banktivity, CountAbout, Rocket Money and Moneydance — adopting their
table-stakes features while keeping SmrtCash self-hosted and private. As of
`0.13.5`, Phases 1–9 and the post-Phase-9 backlog are all complete except for
native mobile (deferred — the PWA covers it). See the [Roadmap](./ROADMAP.md)
for phase detail and the [Changelog](../CHANGELOG.md) for per-release notes.

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
| Non-AI rules engine auto-applies during import (tenant-scoped, with enable/priority) | ✅ |
| Transaction splits (one transaction → multiple categories) | ✅ |
| Dedicated uncategorized review queue with inline categorization | ✅ |
| Transfer linking between your own accounts | ✅ |
| Recurring & subscription detection (AI-suggested, human-verified) | ✅ |
| Subscription action queue (flag → cancel / alter / keep with notes) | ✅ |
| AI subscription discovery (Claude-powered, filters out non-subscriptions) | ✅ |
| Receipt & file attachments | ✅ |

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
| Tax-category tagging + year-end Schedule A / C reports (JSON + CSV) | ✅ |
| Data portability (full account-scoped export bundle) | ✅ |
| Canned reports catalog (CSV export per report) | ✅ |

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
