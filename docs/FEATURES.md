# SmrtCash — Feature List

Legend: ✅ available now · 🔜 next · 📋 planned (phase shown)

The planned set is shaped by a competitive review of Monarch, Simplifi,
Empower, Banktivity, CountAbout, Rocket Money and Moneydance — adopting their
table-stakes features while keeping SmrtCash self-hosted and private. See the
[Roadmap](./ROADMAP.md) for phase detail.

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
| Manual assets & liabilities (property, vehicles, loans) | 📋 Phase 7 |

## Importing & Connectivity

| Feature | Status |
|---------|--------|
| Import CSV and Excel (`.xlsx` / `.xls`) files | ✅ |
| Auto-detect Chase credit-card and checking/savings layouts | ✅ |
| Generic column-mapping for any other bank | ✅ |
| Import preview, per-row error reporting, duplicate detection | ✅ |
| Import history (batches) per account | ✅ |
| OFX / QFX / QIF import (Quicken & CountAbout migration) | 📋 Phase 8 |
| Pluggable account data-source layer | 📋 Phase 8 |
| OFX Direct Connect (direct bank protocol, no aggregator) | 📋 Phase 8 |
| Optional Plaid sync (opt-in cloud aggregation) | 📋 Phase 8 |
| Scheduled background sync & auto-import | 📋 Phase 8 |

## Transactions

| Feature | Status |
|---------|--------|
| View, filter by account, full-text search, pagination | ✅ |
| Original bank description, memo, and source category preserved | ✅ |
| Money shown as exact currency, color-coded in/out | ✅ |
| AI-cleaned merchant names & categorization | ✅ |
| Manual edit / re-categorize | ✅ |
| Transfer linking between your own accounts | ✅ |
| Recurring & subscription detection (AI-suggested, human-verified) | ✅ |
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
| Conversational AI financial assistant | 📋 Phase 9 |

## Budgeting & Cash Flow

| Feature | Status |
|---------|--------|
| Flex budgeting — fixed categories plus a variable-spending pool | ✅ |
| Budget periods — weekly / bi-weekly / semi-monthly / monthly / custom | ✅ |
| Monthly budget-vs-actual tracking | ✅ |
| Savings goals with progress tracking | ✅ |
| Bill reminders & upcoming-bills view | ✅ |
| Simple cash-flow forecast from recurring items | ✅ |

## Wealth & Net Worth

| Feature | Status |
|---------|--------|
| Investment holdings — cost basis & current value | 📋 Phase 7 |
| Net worth over time across all accounts | ✅ |
| Multi-currency support with exchange rates | 📋 Phase 7 |
| Retirement / long-term goal projections | 📋 Phase 7 |

## Insights & Reporting

| Feature | Status |
|---------|--------|
| Spending by category | ✅ |
| Income vs. expense trends | ✅ |
| Dashboard with charts | ✅ |
| Filtered CSV export | ✅ |

## Mobile & Experience

| Feature | Status |
|---------|--------|
| Installable PWA (responsive, mobile home-screen) | 📋 Phase 9 |
| Bill-splitting / shared expenses | 📋 Phase 9 |
| Calendar budget view | 📋 Phase 9 |

## Data Integrity & Security

| Feature | Status |
|---------|--------|
| Money stored as integer cents — never floating point | ✅ |
| Parameterized SQL everywhere (injection-safe) | ✅ |
| Transactional, all-or-nothing imports | ✅ |
| 279-test automated suite (unit → e2e) | ✅ |
| Local-first — data stays in your PostgreSQL | ✅ |
| Single-user authentication | ✅ |
| Encryption at rest (attachments AES-256-GCM; DB via host volume) | ✅ |
| Hardened Docker container | ✅ |

---

## Platform

- **Web application**, becoming an installable PWA (Phase 9)
- **Backend API** — Fastify + TypeScript
- **Database** — PostgreSQL 17 (runs as a Docker container)
- **Self-hosted** — runs entirely on hardware you control

See [ROADMAP.md](./ROADMAP.md) for the full phase plan and the longer-term
backlog, and [TESTING.md](./TESTING.md) for how the suite is verified.
