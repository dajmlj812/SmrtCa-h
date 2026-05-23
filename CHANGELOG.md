# Changelog

All notable changes to SmrtCash are documented here.

This project adheres to [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## [Unreleased]

_Phase 7 work will land here._

---

## [0.6.0] — 2026-05-22 — Phase 6: Budgeting & Cash Flow

Five tightly-related features in one release: flex budgets, monthly
budget-vs-actual, savings goals, bill reminders, and a 90-day cash-flow
forecast on the dashboard.

### Added

- **Flex budgeting.** New `budgets` table (migration 006) with one row
  per `(period_month, category_id)` — `category_id IS NULL` is the
  flex-pool catch-all.
  - `GET /api/budgets?month=YYYY-MM-01` lists a month's budgets.
  - `POST /api/budgets` upserts on the `(month, category)` key so the
    same call creates new rows or updates existing ones.
  - `POST /api/budgets/copy { fromMonth, toMonth }` clones rows month
    to month, skipping any that already exist.
  - `DELETE /api/budgets/:id`.
- **Budget vs actual.** `GET /api/budgets/actual?month=YYYY-MM-01`
  returns per-category budgeted vs actual spend. The flex-pool row's
  actual is computed as spend in categories that **don't** have an
  explicit budget that month (plus uncategorized rows). Transfers are
  excluded from both sides.
- **Savings goals.** `savings_goals` table with name, target, current,
  optional target date. Server-computed `progress` is `current / target`
  capped at 1. Full CRUD via `/api/goals`.
- **Bill reminders.** `bills` table (name, amount, frequency, next due,
  optional category + account, active flag). CRUD via `/api/bills`;
  `POST /api/bills/:id/mark-paid` advances `next_due_date` by the
  bill's frequency (monthly / weekly / biweekly / yearly) or sets
  `active=false` for one-time bills.
- **Upcoming bills view.** `GET /api/bills/upcoming?days=30` returns
  active bills whose `next_due_date` is within the window. Shown as a
  panel on the dashboard.
- **Recurring income** as a sibling concept — `recurring_income` table
  + `/api/recurring-income` CRUD. Kept separate from bills so the
  cash-flow projection doesn't have to inspect signs everywhere.
- **Cash-flow forecast.** `GET /api/cash-flow?days=90` walks the
  current net worth forward through every projected bill / income event
  in the window, returning a per-day balance series. Inactive bills
  are ignored. Surfaced as a line chart on the dashboard.

### Web

- New **Budgets** page (`/budgets`): month picker, total-budgeted /
  total-spent / remaining header, per-row progress bars (red when over
  budget), flex-pool row, add-budget form, and a one-click
  "Copy from previous month" affordance.
- New **Goals** page (`/goals`): card grid with progress bars, create /
  edit / delete modal, target-date countdown when set.
- New **Bills** page (`/bills`): tables for bills and recurring income,
  add / mark-paid / delete actions.
- **Dashboard** gains two new tiles: "Upcoming bills (next 30 days)"
  list and the 90-day cash-flow forecast line chart with the
  start → end balance summary.

### Tests

- **+20 server tests** (230 → 250): 8 budget tests (CRUD, upsert,
  flex-pool actuals, copy-from-previous-month, transfer exclusion),
  5 goal tests (CRUD, progress cap, validation), 7 bills + cash-flow
  tests (mark-paid advances date, one-time deactivates, upcoming
  window, recurring income CRUD, projection math, inactive-bill
  exclusion).
- Total automated coverage: **263 tests** (server 250 + web 6 + e2e 7).

### Fixed

- **`SESSION_SECRET` empty-string handling.** When the host `.env` had no
  `SESSION_SECRET`, docker-compose interpolated it to `""` and the
  config's `??` fallback (catches only null/undefined) let the empty
  string through to `@fastify/cookie`, which crashed on signing. The
  fallback now uses `||` so an empty interpolation degrades the same as
  unset — an ephemeral per-process secret is generated and the server
  boots. Surfaced during Phase 6 dogfooding.

### Migration notes

- **Upgrading from 0.5.0:** `npm run migrate --prefix server` applies
  migration 006 (`budgets`, `savings_goals`, `bills`, `recurring_income`
  + indexes).

---

## [0.5.0] — 2026-05-22 — Phase 5: Dockerization, Auth & Hardening

Single-user authentication, encryption-at-rest for attachments, a
single-container production image, and a backup tool — turns the dev
stack into something safe to actually deploy. **Closes KI-03 (no auth)
and KI-04 (migrations not in `dist/`).**

### Added

- **Single-user authentication.**
  - Argon2id password hashing (`argon2` v0.44, OWASP 2024 defaults).
  - Signed httpOnly + sameSite=strict session cookie via
    `@fastify/cookie`. Sessions stored server-side in a new `sessions`
    table; lookup on every request.
  - Routes: `GET /api/auth/status`, `POST /api/auth/setup` (first boot
    only), `POST /api/auth/login`, `POST /api/auth/logout`,
    `GET /api/auth/me`.
  - Auth gate on every `/api/*` route except health/status/setup/login/
    logout. Static asset requests pass through so the login screen can
    load before authentication.
  - **First-boot UX** — when no user exists the web app shows a "Set
    your password" screen; subsequent visits show the login page until
    a session is established.
- **Attachment encryption at rest.**
  - `ATTACHMENT_ENCRYPTION_KEY` env var (32 bytes as base64 or hex).
  - When set, new uploads are AES-256-GCM encrypted on disk
    (12-byte IV + ciphertext + 16-byte tag).
  - `attachments.encryption_version` column (migration 005) is the
    source of truth; existing v=0 plaintext files keep working so the
    upgrade is non-destructive.
- **Single-container Docker image.**
  - Multi-stage `Dockerfile` at the repo root: builds the web bundle,
    builds the server, copies the SQL migrations into `dist/`, ships a
    minimal `node:22-alpine` runtime as a non-root `node` user.
  - Server registers `@fastify/static` to serve the prebuilt web SPA at
    every non-API path — one container, one port.
  - `docker-compose.yml` adds an `app` service alongside `db`, with a
    named `smrtcash-attachments` volume mounted at `/data/attachments`,
    healthchecks on both services, and full env wiring.
  - `tini` is the entrypoint so signals + zombie reaping are clean.
  - `.dockerignore` keeps `node_modules`, `data/`, `.env`, `.claude/`,
    samples, and Playwright outputs out of the build context.
- **Backup + restore tooling.**
  - `npm run backup` (`scripts/backup.mjs`) — snapshots Postgres via
    `pg_dump --format=custom` and the attachments tree as a `.tgz` into
    `./backups/<timestamp>/`.
  - `npm run restore -- <dir>` (`scripts/restore.mjs`) — destructive
    restore with a "type `restore` to confirm" prompt; `--force` to
    skip. Replaces the attachments directory atomically.
- **Migrations now ship in `dist/`.** The Dockerfile copies
  `src/db/migrations/*.sql` into `dist/db/migrations/` so the runner
  works against the compiled output. Closes KI-04.

### Changed

- **CORS** registered with `credentials: true` so the session cookie
  rides on dev cross-origin requests.
- **Web `http()` fetch wrapper** sets `credentials: 'include'` on every
  call; 401 responses throw a typed `AuthRequiredError` so the App can
  bounce to the login screen.
- **Web App shell** now wraps every existing route in an auth-state
  gate: `loading` → `needs-setup` → `needs-login` → `authenticated`.
- **e2e** — `setup-db.mjs` truncates `users` and `sessions` too;
  Playwright `globalSetup` runs the first-boot flow once and stores the
  resulting cookie via `storageState`, so every existing spec keeps
  working unchanged.

### Documentation

- `docs/ADMIN_GUIDE.md` — backup/restore commands, security checklist
  rewritten around the new env vars, HTTPS-via-Caddy section, and a
  formal **Dependency vulnerability policy** (cadence, severity SLAs,
  pinning approach).
- `.env.example` — documents `SESSION_SECRET`, `COOKIE_SECURE`,
  `ATTACHMENT_ENCRYPTION_KEY` with `node -e "..."` key-generation
  snippets.
- `docs/KNOWN_ISSUES.md` — KI-03 and KI-04 removed.

### Tests

- **+16 server tests** (214 → 230): 12 auth integration tests
  (status / setup / login / logout / me / gate) and 4 encryption unit
  tests (write-encrypts, round-trip, plaintext-backcompat, wrong-key
  rejects).
- Existing tests continue to pass — `makeTestApp()` was upgraded so
  `app.inject()` auto-attaches a seeded session cookie; specs that
  exercise the unauthenticated paths pass `skipAuth: true`.
- Total automated coverage: **243 tests** across server (230) + web (6)
  + Playwright e2e (7).

### Migration notes

- **Upgrading from 0.4.0:**
  - `npm run migrate --prefix server` applies migration 005
    (`users`, `sessions`, `attachments.encryption_version`).
  - Add `SESSION_SECRET` to `.env`; without it the server generates an
    ephemeral one and existing sessions are invalidated on every restart.
  - Optionally set `ATTACHMENT_ENCRYPTION_KEY` to start encrypting new
    uploads. Existing files remain readable as plaintext.
  - First load of the web app shows the **Set your password** screen.
- **Docker upgrade path:** `docker compose -p smrtcash build app` then
  `docker compose -p smrtcash up -d`. The image self-migrates at boot.

---

## [0.4.0] — 2026-05-22 — Phase 4: Insights & Reconciliation

### Added

- **Transfer detection.** A new `POST /api/transfers/detect` pairs
  equal-opposite amounts on different accounts within 5 days of each other
  and tags both with a shared `transfer_group_id`. Ambiguity is resolved by
  picking the closest-date candidate; one transaction can belong to at most
  one group. A `POST /api/transfers` endpoint takes `{aId, bId}` for manual
  linking (e.g. a wire transfer with a fee, where the two legs are not
  penny-equal), and `DELETE /api/transfers/:groupId` unlinks. A
  **Transfers** page in the web app drives all of this; rows already
  in a transfer group show a `↔ transfer` pill on the Transactions page.
- **Opening balances + true running balance.** `accounts.opening_balance_cents`
  and `opening_balance_date` (migration 004). `PATCH /api/accounts/:id`
  edits them. Account balance now equals `opening + sum(txns on/after
  opening_date)`. The transactions list response gains a per-row
  `running_balance_cents` (computed via a SQL window function, `NULL` for
  pre-opening rows). The Account Detail page shows the running balance
  column and an inline edit form for the opening balance. **Closes KI-01.**
- **Insights endpoints**:
  - `GET /api/insights/spending-by-category` — totals by category over a
    date range, excludes transfers.
  - `GET /api/insights/income-expense` — monthly buckets for the last N
    months (default 12, capped at 60), excludes transfers.
  - `GET /api/insights/net-worth-over-time` — end-of-month total across
    all accounts for the last N months. Transfers self-cancel and need no
    special handling here.
- **Dashboard** (`/` route) — three Recharts panels: pie of spending by
  parent-category for the current month, grouped bar of income vs. expense
  for the last 12 months, and a line of net worth over time.
- **Filtered CSV export.** `GET /api/transactions/export` streams a CSV
  honoring the same filters as the list endpoint plus optional
  `start`/`end` date bounds. Always-quoted cells with doubled internal
  quotes for safety; UTF-8; date-stamped filename via
  `Content-Disposition`. An **Export CSV** button on the Transactions page
  triggers the download with the current filter state.

### Changed

- **Sidebar navigation** — `/` is now the Dashboard (was Accounts); the
  Accounts list moves to `/accounts`. New entries for **Transfers** and
  the dashboard.
- **Transaction list query** restructured to compute `running_balance_cents`
  in an inner query (against the full account history) and `transfer_group_id`
  is included so the UI can render the transfer pill.
- **Insights and CSV-export queries** explicitly skip rows with a non-null
  `transfer_group_id` so internal moves don't pollute spending or income
  totals. Net-worth aggregation does *not* filter — transfer debits and
  credits cancel naturally across accounts.

### Documentation

- `docs/KNOWN_ISSUES.md` — KI-01 removed (resolved by opening balances).
- `docs/FEATURES.md` — transfer linking, true balance reconciliation,
  spending by category, income vs expense, net worth over time, dashboard
  with charts, and filtered CSV export all flipped to ✅.

### Tests

- **+36 server tests** (178 → 214): 13 transfer integration tests
  (detection edge cases, manual link, unlink, account scoping),
  8 opening-balance + running-balance tests, 6 insights tests
  (per-category, monthly buckets, net worth, transfer exclusion), 5 CSV
  export tests (header, escaping, date filtering, empty result, bad input).
- Total automated coverage: **227 tests** across server (214) + web (6) +
  Playwright e2e (7).

### Migration notes

- **Upgrading from 0.3.0:** `npm run migrate --prefix server` to apply
  migration 004 (opening-balance columns on `accounts` + partial index on
  `transactions.transfer_group_id`). Default values are zero / null, so
  existing data behaves the same as before until you set an opening balance.
- New web dep: `recharts` for the dashboard charts (~40 packages, no
  vulnerabilities).

---

## [0.3.0] — 2026-05-22 — Phase 3: Receipts & Attachments

### Added

- **Receipt & file attachments on transactions.** New multipart upload route
  `POST /api/transactions/:id/attachments` accepts JPEG / PNG / WEBP / PDF
  (25 MB per file, **100 MB aggregate per request**). Files are written to
  `ATTACHMENTS_DIR` (defaults to `<repo>/data/attachments`) under a
  date-sharded layout (`YYYY/MM/<uuid>-<safeFilename>`), with the storage
  path generated server-side from a UUID and a sanitized filename — so the
  upload route is immune to path-traversal via the uploaded filename.
- **Web UI** — a receipt icon on every transaction row opens an attachments
  modal with **drag-and-drop**, multi-file upload, inline image previews,
  PDF icons that open in a new tab, download, and delete.
- **Pluggable receipt OCR.** A new `OcrProvider` interface mirrors the
  Phase-2 normalizer pattern. The **Claude vision provider**
  (`claude-haiku-4-5`) extracts `amountCents`, `date`, `merchant`,
  `confidence` and a free-form `note` via structured outputs. Extracted
  fields are compared against the transaction using a **$0.50 amount /
  3-day date** match tolerance, and the modal flags matches vs. differs.
- **Restart-safe OCR**. A boot-time sweep (`sweepPendingOcr`) finds any
  attachment still at `ocr_status='pending'` from before the previous
  shutdown and retries extraction. Rows whose file has vanished from disk
  are marked `failed`.
- **API endpoints** — `GET /api/transactions/:id/attachments`,
  `POST /api/transactions/:id/attachments`,
  `GET /api/attachments/:id` (download),
  `GET /api/attachments/:id/preview` (inline),
  `DELETE /api/attachments/:id`.
- **Schema** — migration 003 adds OCR columns
  (`extracted_amount_cents`, `extracted_date`, `extracted_merchant`,
  `ocr_provider`, `ocr_status`, `ocr_note`) to `attachments`, with a partial
  index on `ocr_status='pending'` for the sweep.
- **18 additional automated tests** covering filename sanitization, MIME /
  size validation, the path-traversal hardening, the Claude OCR mocked
  client (image + PDF content blocks, response sanitization, error
  paths), the full upload → list → download → preview → delete loop, the
  aggregate-cap 413 path, the OCR sweep (extract / age-skip / file-missing),
  and a Playwright e2e for receipt attach + delete.

### Changed

- `ATTACHMENTS_MAX_REQUEST_BYTES` env var (default `104857600` — 100 MB)
  governs the aggregate cap. Tests drop it to 1 MB to exercise the 413
  path without shipping 100 MB through `app.inject`.
- `transactions` list query now joins on a correlated `attachment_count`
  subquery so the row badge can render without an extra round-trip.

### Migration notes

- **Upgrading from 0.2.1:** `npm run migrate --prefix server` to apply
  migration 003 (OCR columns + partial index). No data backfill is
  required — every row defaults to `ocr_status='pending'`, but no rows
  exist yet on a 0.2.1 install.
- Receipt OCR runs only when `AI_PROVIDER=claude` and `ANTHROPIC_API_KEY`
  is set. Other providers leave attachments at `ocr_status='skipped'`.
- Phase 5 still owns **encryption at rest** and the **Docker volume mount**
  for `ATTACHMENTS_DIR` (the server isn't containerized yet).

---

## [0.2.1] — 2026-05-22 — Phase 2.1: Comprehensive Categories & Suggestion Review

### Added

- **Comprehensive hierarchical category taxonomy** — 23 top-level groups
  containing ~167 sub-categories (e.g. Transportation → Auto Loan Payment,
  Auto Insurance, Gas & Fuel, Auto Service, Auto Parts, Vehicle Upgrades &
  Accessories, Parking, Tolls, Public Transit, Taxi & Rideshare, Vehicle
  Registration & DMV). The full tree is the single source of truth in
  `server/src/domain/categories.ts`.
- **AI-suggested-category review flow** — when the AI normalizer returns a
  category not in the taxonomy, the suggestion is captured in a new
  `category_suggestions` table and the originating transactions are tagged
  via `transactions.suggested_category_name`. The Categories page shows a
  Suggestions panel with **Approve as new** (optionally placing the new
  category under an existing group), **Merge into existing** (link to an
  existing category instead), and **Reject** actions.
- New API surface: `GET /api/suggestions`,
  `POST /api/suggestions/:id/approve|merge|reject`.
- The transaction category dropdown now renders categories grouped by
  parent using `<optgroup>` so picking from ~190 categories stays usable.

### Changed

- `seedDefaultCategories` is now idempotent and hierarchy-aware: it inserts
  groups first, then re-parents any *legacy* top-level row whose name now
  belongs under a group (so existing `Gas & Fuel` assignments survive the
  move under Transportation without breaking foreign keys).
- `NormalizationResult` gains a `suggestedCategory` field; `mergeWithBatch`
  populates it when the AI returns a name outside the allowed taxonomy
  (explicit "Uncategorized" is *not* treated as a suggestion).

### Migration notes

- **Upgrading from 0.2.0:** `npm run migrate --prefix server` to apply
  migration 002 (the `category_suggestions` table + the
  `transactions.suggested_category_name` column) and to expand the seeded
  taxonomy. Existing category-id assignments are preserved.

---

## [0.2.0] — 2026-05-22 — Phase 2: AI Transaction Normalization

### Added

- **Pluggable `TransactionNormalizer` interface** with three providers
  selected via `AI_PROVIDER`:
  - **Claude API** (`claude`) — official Anthropic SDK, `claude-haiku-4-5`,
    prompt-cached system prompt, structured outputs via
    `output_config.format`, in-prompt batching at 25 transactions per call,
    typed-exception error handling.
  - **Ollama** (`ollama`) — local model via the Ollama HTTP API, JSON-mode
    output with defensive parsing of noisy responses.
  - **Rules** (`rules`, the new default) — deterministic baseline that
    cleans merchant names, applies a strong-override list (Uber One,
    streaming services, Adobe → Subscriptions), maps Chase's source
    categories, and falls back to keyword rules.
- **Default 20-entry category taxonomy** seeded by `npm run migrate` and
  re-seeded after every `resetDb()` in tests.
- **`POST /api/normalize`** — runs normalization on pending transactions,
  optionally scoped to one account.
- **`GET / POST / PATCH / DELETE /api/categories`** for the user-editable
  taxonomy, with case-insensitive uniqueness.
- **`PATCH /api/transactions/:id`** — manual category edits set the row's
  `normalization_status` to `manual` so future AI runs leave it alone.
- **`GET /api/ai/status`** surfaces the configured provider in the UI.
- **Web UI** — Categories page; Normalize button + status filter
  (All / Pending / Normalized / Manual) + inline category dropdown on the
  Transactions page; AI-provider indicator; status pills per row.
- 42 additional automated tests covering each provider, the normalize
  endpoint, transaction PATCH, and a functional import → normalize pipeline
  test. Total suite is now 137 tests.

### Changed

- Default `AI_PROVIDER` is now **`rules`** (was `none`), so a fresh install
  gets working baseline normalization with no configuration.
- Accounts route hardened against type-confused request bodies — a non-string
  in `name` or `type` now returns 400 instead of crashing with a 500.
- Server refactored to export a `buildApp()` factory so integration tests can
  drive the app via `app.inject()` without a network listener.

### Documentation

- Roadmap rewritten to nine phases informed by a competitive review (Monarch,
  Simplifi, Empower, Banktivity, CountAbout, Rocket Money, Moneydance).
- New [Process playbook](./docs/PROCESS.md), [Contributing
  guide](./docs/CONTRIBUTING.md), and this CHANGELOG.

### Migration notes

- **Upgrading from 0.1.0:** run `npm run migrate --prefix server` after
  pulling 0.2.0. The migrate step now seeds the 20 default categories in
  addition to applying any schema changes (it is idempotent — safe to run
  more than once). Without this step normalization runs but every row falls
  back to `(uncategorized)` because the category names cannot resolve to
  ids.

---

## [0.1.0] — 2026-05-22 — Phase 1: Foundation & Import

### Added

- Monorepo scaffold (`server/` + `web/` + `e2e/`) on Node 24 + TypeScript.
- PostgreSQL 17 running as a `docker-compose` service; SQL migration runner.
- Fastify + TypeScript API with a single structured error handler.
- CSV & XLSX importer with auto-detection of Chase credit-card and Chase
  checking/savings exports, plus a generic column-mapping path for any other
  bank.
- Per-row error reporting (bad rows skipped, good rows kept) and duplicate
  detection via a stable occurrence-counter hash.
- Money stored as integer cents throughout — never floating point.
- React + Vite web app: Accounts, Transactions, Account Detail, Import
  wizard.
- 95-test automated suite spanning unit, integration, functional, security,
  smoke, performance and Playwright end-to-end layers.
- Full documentation set: Quick Start, Installation, Admin Guide, General
  Documentation, Features, Roadmap, Known Issues, Testing.

### Verified end-to-end

- 1,944 real Chase transactions imported (Chase Credit Card 0444 — 440 rows;
  Chase Checking 5793 — 1,504 rows). Re-import correctly imported 0 / skipped
  all duplicates.
