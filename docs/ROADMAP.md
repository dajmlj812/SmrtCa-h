# SmrtCash — Roadmap

## Vision

SmrtCash is a **self-hosted personal finance manager** in the spirit of Quicken
and Monarch. It is built to run as a single, secure Docker container on
hardware you control, so your financial data never leaves your machine.

The product is delivered in phases. Each phase produces a usable application —
nothing is "all or nothing."

| Phase | Theme | Status |
|-------|-------|--------|
| 1 | Foundation & Import | ✅ Complete — 2026-05-22 |
| 2 | AI Transaction Normalization | ✅ Complete — 2026-05-22 |
| 3 | Receipts & Attachments | ✅ Complete — 2026-05-22 |
| 4 | Insights & Reconciliation | ✅ Complete — 2026-05-22 |
| 5 | Dockerization, Auth & Hardening | ✅ Complete — 2026-05-22 |
| 6 | Budgeting & Cash Flow | ✅ Complete — 2026-05-22 |
| 7 | Wealth & Net Worth | ✅ Complete — 2026-05-23 |
| 8 | Connectivity & Automation | 🔜 In progress — 8.0 ✅ · 8.1 ✅ |
| 9 | Mobile, Assistant & Experience | 📋 Planned |

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

## Phase 8 — Connectivity & Automation 🔜

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
- **8.2** 📋 — **Plaid integration**, super-admin-gated and disabled
  by default. Clearly flagged as leaving the fully-local model.
  Same data-source interface, different backend.
- **8.3** 📋 — **scheduled background sync** + auto-import. A
  per-tenant cadence calls `fetch()` on each enabled data source
  and runs the same dedup + persistence path.

---

## Phase 9 — Mobile, Assistant & Experience 📋

**Goal:** Make SmrtCash a pleasure to use anywhere.

- **Installable PWA** — responsive, mobile-optimized layout, installable to a
  phone's home screen, still served from your own container
- **AI financial assistant** — conversational insights and Q&A over your data
  (builds on the Phase 2 AI infrastructure; Monarch-style)
- **Bill-splitting / shared expenses** (Monarch-style)
- **Calendar budget view** (Calendarbudget-style)

---

## Beyond — Backlog 💡

- Multi-user / household mode with per-user permissions
- Tax-category tagging and year-end reports
- Cryptocurrency tracking (Simplifi-style)
- Non-AI rules engine for auto-categorization
- Advanced cash-flow forecasting & spending-anomaly alerts
- Native mobile apps — only if the PWA proves insufficient
- Data export / portability tooling

---

*This roadmap is a living document. Phase scope and ordering may shift as the
product is used and priorities become clearer.*
