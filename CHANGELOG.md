# Changelog

All notable changes to SmrtCash are documented here.

This project adheres to [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## [Unreleased]

_Backlog progressing. 0.13.0 / 0.13.1 / 0.13.2 shipped. Next: 0.13.3
crypto tracking, 0.13.4 permission tuning. Native mobile deferred._

---

## [0.13.2] — 2026-05-23 — Anomaly alerts

Third backlog release. Detects three classes of unusual transactions
and surfaces them on a new `/anomalies` page, with optional SMTP
digest emails on every scan. Disabled by default — flip
`ANOMALY_ENABLED=true` in super-admin settings to turn it on.

### Detection rules

- **`large_amount`** — any single transaction whose absolute spend
  ≥ `ANOMALY_LARGE_TXN_THRESHOLD_CENTS` (default $500). Severity
  bumps to `high` at 2× threshold.
- **`unusual_at_merchant`** — transaction whose absolute amount is
  ≥ `ANOMALY_MULTIPLIER` × the median spend at the same merchant
  (default 3×). Only fires when the merchant has been seen at
  least **5 prior times** (GROUP BY HAVING `>= 6` accounts for the
  candidate row itself being in the stats).
- **`duplicate_suspect`** — same account + same amount + same
  merchant within 24h. Self-join surfaces only the second row of
  each pair (later `created_at`).

### Schema (migration 026)

- `anomaly_alerts` with `UNIQUE (transaction_id, kind)` so re-scans
  are idempotent (ON CONFLICT DO NOTHING everywhere). Partial
  index `(tenant_id) WHERE dismissed = false` keeps the nav-badge
  count fast.

### Settings (super-only, all default off)

- `ANOMALY_ENABLED`, `ANOMALY_LARGE_TXN_THRESHOLD_CENTS` (default
  50000), `ANOMALY_MULTIPLIER` (default 3, min 1.5),
  `ANOMALY_EMAIL_TO` (optional digest recipient).

### Server

- `domain/anomaly-detector.ts` — `scanTransactionsForAnomalies(tenantId, txnIds?)`.
  Three SQL passes per scan, each with ON CONFLICT DO NOTHING. On
  new alerts + `ANOMALY_EMAIL_TO` set + SMTP configured, sends a
  single digest email via the existing `tryMail()` (one mail per
  scan, not per alert — avoids mail-bombing on a big import).
- Routes: `GET /api/anomalies` (open by default,
  `?includeDismissed=1` to widen), `GET /api/anomalies/count` for
  the nav badge, `POST /api/anomalies/scan` (admin+spouse,
  audit-logged), `POST /api/anomalies/:id/dismiss`.
- `persistBatch()` runs an awaited scan over freshly-imported
  ids after the transaction commits, wrapped in try/catch so a
  detector failure never breaks the import. Awaited (not
  fire-and-forget) so concurrent vitest workers can't race each
  other's `resetDb()`s.

### Web

- New `/anomalies` page grouped by kind (Large amount /
  Unusual at merchant / Possible duplicate), severity pill per
  row (high / warn / info), Dismiss + Re-open toggle, "Include
  dismissed" filter, "Run scan now" button.
- Nav link between Tax and Reports.

### Tests (+9 server)

- `tests/integration/anomalies.test.ts`: disabled gate, large_amount
  detection + idempotent re-scan, unusual_at_merchant 5+1 fires /
  4+1 doesn't, duplicate_suspect within 24h, tenant isolation,
  route CRUD round-trip, `/count` for the nav badge.
- Total: **535 tests** (529 server + 6 web), all green.

### Files

```
server/src/db/migrations/026_anomaly_alerts.sql      (new)
server/src/domain/anomaly-detector.ts                (new)
server/src/domain/settings.ts                        (+ANOMALY_* keys)
server/src/routes/anomalies.ts                       (new)
server/src/app.ts                                    (register route)
server/src/import/importer.ts                        (persistBatch
                                                      now scans inserted ids)
server/tests/setup/test-db.ts                        (TRUNCATE anomaly_alerts)
server/tests/integration/anomalies.test.ts           (new)
web/src/api.ts                                       (anomaly types + methods)
web/src/pages/AnomaliesPage.tsx                      (new)
web/src/App.tsx                                      (nav + route)
```

---

## [0.13.1] — 2026-05-23 — Tax-category tagging + year-end reports

Second backlog release. Tags categories with an optional
`tax_category` and adds a year-end report that aggregates only the
tagged ones — Schedule A / Schedule C style summaries without forcing
users to maintain a parallel taxonomy.

### Schema (migration 025)

- `categories.tax_category text` (nullable). NULL = not tax-relevant.
  Free-text — the controlled vocabulary lives in the UI's datalist,
  not the DB CHECK. US Schedule A/C labels are too varied to enum.
- Partial index `WHERE tax_category IS NOT NULL` so the report's
  GROUP BY stays cheap as the categories table grows.

### Server

- `GET /api/categories/tax-vocabulary` — returns the suggested list
  the UI uses as datalist options (Charitable Donations, Mortgage
  Interest, Wages (W-2), 1099 Income, Business Expense — Office,
  etc.). 16 entries covering common Schedule A + Schedule C lines.
- `POST /api/categories` accepts optional `tax_category`.
- `PATCH /api/categories/:id` accepts `name` or `tax_category` in
  isolation. Empty-string `tax_category` clears the tag. Existing
  callers that only sent `name` still work.
- `GET /api/reports/tax-year/:year` — tenant-scoped. Aggregates
  every transaction whose category has `tax_category IS NOT NULL`
  over Jan 1 – Dec 31. Splits per-tax-category totals by sign
  (`income` vs `deductible`) so a refund-heavy tag and a normal
  income tag don't get smushed into one number. **Transfers
  excluded** (`transfer_group_id IS NULL`).
- `GET /api/reports/tax-year/:year.csv` — same data as CSV with the
  standard download headers. Properly escapes commas / quotes.
- Assistant gets `tax_year_summary` (read tool). 16 tools total
  now.

### Web

- `CategoriesPage` row layout grows a third column: a free-text
  input bound to the `<datalist>` of suggestions. Blur saves; empty
  clears. The existing rename + delete buttons are untouched.
- New `/tax` page (`TaxYearPage.tsx`) with year picker (current
  year + 5 prior), three summary cards (income / deductible /
  tagged-txn-count), and a per-tax-category table split into
  income vs deductible sections. Download-CSV button hits the
  CSV endpoint directly so the browser handles the save.
- Nav link in the tenant sidebar between Calendar and Reports.

### Tests (+7 server)

- `tests/integration/tax-year.test.ts`:
  - `PATCH /api/categories/:id` sets and clears `tax_category`
    independently of `name`.
  - Tax-vocabulary endpoint returns the suggestion list.
  - Year-format validation (`/tax-year/abc` → 400).
  - End-to-end aggregation: per-tax-category totals + contributing-
    category lists, with year-boundary guards (Dec 31 of prior year
    and Jan 1 of next year MUST NOT count) and untagged-category
    invisibility.
  - Transfers excluded from the report (`transfer_group_id` set).
  - CSV download has `text/csv` content-type + proper filename
    header + the expected row format.
  - Tenant isolation — a transaction owned by another tenant's
    account does not leak into the calling tenant's report.
- Total: **526 tests** (520 server + 6 web), all green.

### Files

```
server/src/db/migrations/025_tax_categories.sql       (new)
server/src/routes/categories.ts                       (+tax_category in
                                                       create/patch/list +
                                                       vocabulary endpoint)
server/src/routes/tax-year.ts                         (new)
server/src/app.ts                                     (register route)
server/src/domain/assistant/tools.ts                  (+tax_year_summary)
server/tests/integration/tax-year.test.ts             (new)
web/src/api.ts                                        (taxVocabulary +
                                                       taxYearReport + types,
                                                       updateCategory signature)
web/src/pages/CategoriesPage.tsx                      (+tax cell + datalist)
web/src/pages/TaxYearPage.tsx                         (new)
web/src/App.tsx                                       (nav + route)
web/src/styles.css                                    (cat-row 4-col grid)
```

---

## [0.13.0] — 2026-05-23 — Data portability tooling

First post-roadmap backlog release. Per-tenant export of every row +
every attachment into a single portable `.tar.gz` bundle. Distinct
from the server-wide `npm run backup` (which is a Postgres custom
dump): this format is **portable** — JSON tables a human can read
and an external script can re-import.

### Server

- New `server/src/domain/portability.ts` exposing
  `exportTenantData(tenantId)`. Walks 19 tenant-scoped tables in a
  deterministic order, copies every attachment from disk into an
  `attachments/` subdirectory, writes a `tenant.json` manifest +
  bundle, then tar+gzips the whole thing into a temp file. Returns
  a cleanup callback the route runs after the stream completes.
- **Secrets are stripped.** `ofx_dc_connections.username_encrypted`
  / `password_encrypted` and `plaid_items.access_token_encrypted`
  are excluded from the SELECT lists. Connection metadata is kept
  so the user has a record of which banks they were linked to.
- Attachment files are bundled **verbatim** — still encrypted at
  rest if `encryption_version = 1`. A re-import needs the same
  `ATTACHMENT_ENCRYPTION_KEY` to read them. The manifest's `notes`
  field calls this out explicitly.
- New `server/src/routes/portability.ts` — `GET /api/portability/export`.
  Admin-only (same gate as auth-provider config + member management).
  Streams the file with `Content-Type: application/gzip` +
  `Content-Disposition: attachment` + `Content-Length` + a custom
  `X-Smrtcash-Counts` header so the UI can show row counts after
  the download without re-parsing the tarball.
- Every export writes an `audit_log` row with action
  `portability.export` so the super-admin can see when a tenant
  bulk-pulled their data.

### Web

- New "Data portability" section on `/workspace` (admin-only). One
  "Export all my data" button triggers a same-origin fetch, reads
  the counts header, then synthesizes a `<a download>` click on a
  Blob to save the file. After completion the page shows the
  archive size + per-table counts.

### Tests (+7 server)

- `tests/integration/portability.test.ts`:
  - Produces a tar.gz with manifest + every expected table key.
  - Strips encrypted credential blobs from `ofx_dc_connections`
    and `plaid_items` even when the rows exist.
  - Cross-tenant isolation: a transaction belonging to another
    tenant's account is never bundled.
  - Audit log entry written on every route hit.
  - 403 for non-admin role (spouse can read everything but can't
    bulk-export).
  - Headers: `Content-Type`, `Content-Disposition` filename,
    `X-Smrtcash-Counts` is valid JSON containing `accounts`.
  - Attachment files actually arrive inside the bundle and round-
    trip their contents.
- Total: **519 tests** (513 server + 6 web), all green.

### Files

```
server/src/domain/portability.ts                (new)
server/src/routes/portability.ts                (new)
server/src/app.ts                               (register route)
server/tests/integration/portability.test.ts   (new)
web/src/pages/WorkspacePage.tsx                 (+PortabilitySection)
```

---

## [0.12.3] — 2026-05-23 — Calendar budget view (Phase 9.3, closes Phase 9 + roadmap)

Final planned roadmap release. With this slice every Phase 9
deliverable from the original roadmap is live, and **all nine
phases are complete**.

### Server

- New `server/src/routes/calendar.ts` — `GET /api/calendar/:month`
  (YYYY-MM). Returns per-day aggregates (spend / income / txn
  count / bill-due-ids), monthly totals (spend / income / budget),
  today's position within the month for pace math, and the next
  14 days of upcoming bills. Tenant-scoped via the
  `accounts.tenant_id` join — surfaced by a tenant-isolation test.
  Postgres does the date math (`date_trunc`, `EXTRACT(DAY FROM …)`)
  so JS Date's local-vs-UTC footguns can't bleed in.
- `GET /api/transactions` extended (**additive**) with
  optional `startDate` / `endDate` query params. Validated as
  YYYY-MM-DD; existing callers unaffected. The CalendarPage day
  drawer uses these to load just one day's worth.
- New assistant tool `calendar_month_summary` (read, tenant-
  scoped). Total assistant tools: **15**.

### Web

- New `web/src/pages/CalendarPage.tsx` and `/calendar` route in
  the tenant sidebar. Month nav (prev / today / next), four
  summary cards (spent / income / budgeted / pace), a 7-column
  grid built from leading-blank + day-cells + trailing-blank so
  the first row aligns to Sunday. Each day cell shows the date,
  spend total, bill-due ▲ marker when applicable, and a faint red
  background tint scaled by that day's spending vs. the month's
  max.
- Clicking a day loads that day's transactions via the new
  date-filter params and renders them under the grid.
- "Upcoming bills (next 14 days)" table below the grid surfaces
  the response's `upcoming_bills` field.
- Calendar CSS appended to `web/src/styles.css`.

### Tests (+7 server)

- `tests/integration/calendar.test.ts` — 7 tests: invalid month
  format (400), days-in-month for May / Feb 2026 / Feb 2028
  (leap), per-day spend + income + count aggregation, month-
  boundary guards (Apr 30 and Jun 1 must NOT appear in the May
  payload), bill-due markers on the right day, budget total
  summed correctly across multiple budget rows for the month,
  cross-tenant isolation (a transaction in another tenant must
  not leak into the default tenant's calendar).
- Total: **512 tests** (506 server + 6 web), all green.

### Files

```
server/src/routes/calendar.ts                 (new)
server/src/routes/transactions.ts             (+startDate/endDate filters)
server/src/app.ts                             (register route)
server/src/domain/assistant/tools.ts          (+calendar_month_summary)
server/tests/integration/calendar.test.ts     (new)
web/src/api.ts                                (calendarMonth + types)
web/src/pages/CalendarPage.tsx                (new)
web/src/styles.css                            (.calendar-* grid)
web/src/App.tsx                               (nav + route)
```

### What's next

This is the last planned release of the original nine-phase
roadmap. From here, future work is **backlog items** (multi-user
permission tuning, tax-category reports, crypto tracking, native
mobile, etc.) or whatever the user decides is the next priority.

---

## [0.12.2] — 2026-05-23 — Bill-splitting (Phase 9.2)

Third Phase 9 release. Track who owes whom across split expenses
(dinner with friends, shared rent, roommate utilities). Distinct
from the existing `transaction_splits` table, which is for CATEGORY
splitting — this is PERSON splitting.

### Schema (migration 024)

- **`split_participants`** — the people you can split with.
  Tenant-scoped, `UNIQUE(tenant_id, name)`. Optional `email` and
  optional `user_id` link (when the participant happens to also be
  a SmrtCash user, e.g. a spouse on the same tenant). Archive
  instead of delete to preserve history.
- **`transaction_shares`** — per-transaction allocation to a
  participant. `share_cents` matches the sign of the transaction
  amount: a negative-cents row means the participant's portion of
  a spending transaction (which, via the API's outward convention,
  appears as "they owe you" net). `UNIQUE(transaction_id,
  participant_id)` so re-saving is idempotent. Partial index on
  `(participant_id) WHERE settled = false` for fast summary
  queries.
- **The tenant's own residual share is NEVER stored** — it's
  computed as `transaction.amount_cents - sum(shares.share_cents)`
  so a downstream amount change can't desync the math.

### Routes (`server/src/routes/shares.ts`)

- `GET /api/split-participants?includeArchived=1` — list.
- `POST /api/split-participants` — create. Returns 409 on duplicate
  name within a tenant.
- `PATCH /api/split-participants/:id` — rename / re-email / toggle
  archived.
- `DELETE /api/split-participants/:id` — also removes that
  participant's shares (FK cascade).
- `GET /api/transactions/:id/shares` — returns the per-share rows
  plus `transactionAmountCents`, `sharesTotalCents`, and
  `yourShareCents` (the implied residual).
- `PUT /api/transactions/:id/shares` — replace all shares in one
  call. Idempotent. Validates: every participant in this tenant,
  every share's sign matches the transaction, total magnitude
  doesn't exceed the transaction amount. Records an audit log
  entry.
- `POST /api/transaction-shares/:id/settle` — `{settled: true}` to
  mark paid, `{settled: false}` to re-open.
- `GET /api/shares/summary` — `net_open_cents` + `open_count` per
  participant.
- `GET /api/shares?participantId=X&onlyOpen=1` — share-level list
  for a participant.

### Assistant tools

Two new tools join the registry (now **14 total**):

- `share_summary` (read) — net owed per participant.
- `split_transaction` (write, audit-logged) — **auto-creates
  participants by name**. "Split this $80 lunch between Cam and
  Dee" works without first creating Cam and Dee through the UI.
  Each call writes an `assistant.split_transaction` row to the
  audit log.

### Web

- New `/sharing` page (`SharingPage.tsx`). Net-balance table per
  participant (positive = they owe you, negative = you owe them),
  drill-in to the per-participant share list, settle / re-open
  toggle, archive-or-delete management, include-archived filter.
- New `SplitTransactionModal.tsx` component. Opened from the new
  👥 button on every transaction row. Editable per-participant
  amounts, **Split equally (incl. you)** button that distributes
  the absolute amount across N+1 (the user plus N participants),
  inline "add a participant" form.
- `TransactionTable` gets an `onOpenShares?` optional prop +
  per-row 👥 button. Existing ✂ category-split button is
  unchanged.
- `TransactionsPage` wires the modal on the new prop.

### Tests (+7 server)

- `tests/integration/shares.test.ts` — 7 tests: participant CRUD
  round-trip, duplicate-name 409, `PUT` shares replaces all + GET
  reports yourShareCents, `PUT` rejects sign mismatch and
  over-allocation, settle toggle is idempotent, summary aggregates
  open shares correctly across multiple transactions and
  settlements, assistant `split_transaction` tool auto-creates
  participants by name and writes the audit-log row.
- Total: **505 tests** (499 server + 6 web), all green.

### Files

```
server/src/db/migrations/024_phase9_2_split_bills.sql   (new)
server/src/routes/shares.ts                             (new)
server/src/app.ts                                       (register routes)
server/src/domain/assistant/tools.ts                    (+2 tools)
server/tests/setup/test-db.ts                           (TRUNCATE split_*)
server/tests/integration/shares.test.ts                 (new)
web/src/api.ts                                          (sharing API + types)
web/src/pages/SharingPage.tsx                           (new)
web/src/components/SplitTransactionModal.tsx            (new)
web/src/components/TransactionTable.tsx                 (+onOpenShares prop)
web/src/pages/TransactionsPage.tsx                      (mount modal)
web/src/App.tsx                                         (nav + route)
```

---

## [0.12.1] — 2026-05-23 — AI assistant (Phase 9.1, agentic)

Second Phase 9 release. Adds an in-app AI assistant that can answer
natural-language questions over your data **and** make changes —
recategorize transactions, bulk re-tag, create budgets, mark bills
paid, top up savings goals. Every write tool call records an entry in
the existing super-admin audit log so the operator can see exactly
what the assistant did and when.

### Tools (`server/src/domain/assistant/tools.ts`)

Twelve tools — 8 read + 4 write. Each tool runs **scoped to the
authenticated session's tenant**. The model never picks the tenant;
the runtime hard-wires it from `req.user.tenantId`.

**Read tools:**

- `query_transactions` — filter by date range, account, category,
  description substring, amount range. Hard cap 200 rows.
- `account_balances` — current balance per account.
- `list_categories` — every category with parent.
- `spending_by_category` — totals over a date range.
- `list_budgets` — per-month budget rows.
- `list_bills` — bill reminders + next-due dates.
- `list_savings_goals` — target / current / deadline.

**Write tools** (all call `recordAudit()` before returning):

- `update_transaction_category` — single transaction.
- `bulk_recategorize` — match by `descriptionContains` ILIKE +
  optional date range, set category in one shot. **Hard cap: 500
  transactions per call** so a confused model can't rewrite the
  whole history.
- `create_budget` — set/upsert a monthly budget. Honors the DB CHECK
  (`amount_cents > 0`).
- `mark_bill_paid` — advances `next_due_date` by the bill's
  frequency.
- `update_savings_goal` — accepts either `deltaCents` or
  `currentCents`.

Every write tool also returns the canonical row data so the assistant
can confirm to the user what changed.

### Runtime (`server/src/domain/assistant/runtime.ts`)

- Tool-use loop against Anthropic's Messages API. Hard cap
  `MAX_ITERATIONS=8` — if the model keeps requesting tools, the
  loop bails with `stopReason='tool_use_loop_cap'` so the UI can
  prompt the user to break the work into smaller asks.
- System prompt explicitly tells the model:
  - Data is tenant-scoped; you can't see other users' data.
  - Prefer querying for current data over guessing.
  - Amounts are integer cents; format as `$` for display.
  - Never invent transaction IDs / category names — call `list_*`
    first.
  - For bulk writes, run the read tool first and confirm intent.
- `assistantAvailable()` checks DB-effective settings (not just
  boot-time config). Returns `{available: false, reason}` until
  `AI_PROVIDER=claude` + `ANTHROPIC_API_KEY` are both set.

### Routes (`server/src/routes/assistant.ts`)

- `GET /api/assistant/status` — available / unavailable + reason.
  Reports unavailable for `child` role regardless of config.
- `POST /api/assistant/chat` — body `{messages: [{role, content}]}`.
  Caps incoming history at last 40 messages. Returns
  `{reply, toolCalls, iterations, stopReason}`. **Children get
  403**; admins + spouses both allowed.

### Web

- New `web/src/pages/AssistantPage.tsx` — chat-style UI with
  message bubbles, inline tool-call chips (🔍 read, ✎ write, red
  on error), suggested starter prompts, Enter-to-send + Shift+Enter
  newline, scroll-to-bottom on update. Hides itself if
  `/api/assistant/status` reports unavailable.
- New nav link in the tenant sidebar, between Connections and Reports.
- Chat-specific styles appended to `styles.css`.

### Test infra fix

- `seedAccount()` previously created accounts with NULL
  `tenant_id`. The new assistant tools correctly enforce tenant
  scoping, which exposed the gap. `seedAccount()` now defaults to
  the seeded Default tenant; existing tests unaffected. Pass
  `tenantId: null` to opt out.

### Tests (+15 server)

- `tests/unit/assistant-tools.test.ts` — 7 tests: tool-registry
  hygiene (unique names, valid input schemas), `query_transactions`
  filters, tenant-isolation (cross-tenant data not leaked),
  `update_transaction_category` + audit entry,
  `bulk_recategorize` updates + audit entry, `create_budget`
  positive-amount enforcement, `mark_bill_paid` date math,
  `update_savings_goal` delta + absolute set.
- `tests/integration/assistant.test.ts` — 8 tests: status off/on,
  child role rejection, empty-payload rejection, read-only loop
  end-to-end, write tool writes an audit entry, tool-error
  recovery (loop continues), MAX_ITERATIONS cap engages.
- Total: **498 tests** (492 server + 6 web), all green.

### Files

```
server/src/domain/assistant/tools.ts          (new)
server/src/domain/assistant/runtime.ts        (new)
server/src/routes/assistant.ts                (new)
server/src/app.ts                             (register routes)
server/tests/setup/test-db.ts                 (seedAccount tenant default)
server/tests/unit/assistant-tools.test.ts     (new)
server/tests/integration/assistant.test.ts    (new)
web/src/api.ts                                (assistantChat + types)
web/src/pages/AssistantPage.tsx               (new)
web/src/styles.css                            (.chat-* + .assistant-page)
web/src/App.tsx                               (nav + route)
```

---

## [0.12.0] — 2026-05-23 — PWA (Phase 9.0)

First Phase 9 release. Makes SmrtCash installable to a phone's home
screen as a real Progressive Web App and does the responsive-CSS
pass that future Phase 9 slices will lean on. No new server code —
the entire change lives in the web bundle and a couple of static
files.

### Manifest + icons

- New `web/public/manifest.webmanifest` — name, short_name,
  `display: standalone`, theme color matching the indigo accent,
  background color matching the light surface, 192 / 512 / maskable
  icons.
- New SVG icons under `web/public/icons/` — vector so they look
  sharp on every density without shipping ten PNG variants.
- `index.html` gains `<link rel="manifest">`, a paired
  `<meta name="theme-color">` for light + dark, and the iOS
  `apple-mobile-web-app-*` meta tags.

### Service worker (`web/public/sw.js`)

- Cache-first for built assets (`/assets/*`, `/icons/*`,
  `/manifest.webmanifest`, `/favicon*`). Vite hashes filenames per
  build, so a new bundle is fetched fresh; old entries rot until
  `activate` purges the previous `CACHE_VERSION`.
- **Network-only for `/api/*`** — financial data must never be
  served from a stale cache. Better to fail visibly than to show
  yesterday's balance.
- Navigation requests: network-first, fall back to cached
  `index.html` when offline. The SPA loads even with no network for
  routes the browser has already visited.
- `skipWaiting` + `clients.claim` so an updated SW takes effect on
  the next page load.
- Registered from `main.tsx` after `load`, only in `import.meta.env.PROD`
  so the Vite dev server isn't confused by a stale SW serving
  yesterday's bundle.

### Install prompt + offline indicator

- New `web/src/components/InstallPrompt.tsx`. Captures
  `beforeinstallprompt`, shows a small fixed card with **Install** /
  **Not now**. Dismissal is durable via `localStorage` —
  if you say no, we stop pestering.
- Auto-hides when the app is already running in standalone mode
  (`display-mode: standalone` media query).
- `OfflineIndicator` floats a small red "Offline" pill when
  `navigator.onLine` flips false. The SW keeps already-visited
  routes usable; this is just a heads-up.

### Mobile drawer + responsive CSS

- New `web/src/components/MobileBar.tsx` with `MobileBar`,
  `SidebarBackdrop`, and `useMobileDrawer` hook. The hook drives a
  `data-open` attribute on the existing `.sidebar` element so the
  drawer CSS works without re-architecting the parent. Auto-closes
  on route change; Escape closes it.
- Bottom of `web/src/styles.css` gets a `@media (max-width: 768px)`
  block:
  - Sidebar becomes a slide-out drawer (80vw, max 280px) with a
    backdrop scrim.
  - `form-grid` and `card-grid` collapse to a single column.
  - Tables get `-webkit-overflow-scrolling: touch` + a `min-width`
    so they scroll horizontally cleanly instead of crushing.
  - Buttons + nav items hit the 44px tap-target floor.
  - Install prompt fills the bottom of the screen on phones.

### Files

```
web/public/manifest.webmanifest            (new)
web/public/sw.js                           (new)
web/public/icons/icon-192.svg              (new)
web/public/icons/icon-512.svg              (new)
web/public/icons/icon-maskable.svg         (new)
web/index.html                             (manifest link + theme color + iOS meta)
web/src/main.tsx                           (SW registration on PROD load)
web/src/styles.css                         (install/offline/hamburger + @media block)
web/src/components/InstallPrompt.tsx       (new)
web/src/components/MobileBar.tsx           (new)
web/src/App.tsx                            (mount mobile bar + drawer + InstallPrompt)
```

### Tests

- No new unit tests — the bits added (`InstallPrompt`,
  `MobileBar`, the service worker) are inherently browser-side and
  the web suite doesn't yet have a React Testing Library setup.
  Existing 482 tests (476 server + 6 web) still green; web build
  succeeds with the manifest + SW + icons emitted to `dist/`.

### Browser smoke notes

- Lighthouse PWA checklist passes locally for the install criteria
  (`manifest.webmanifest`, valid icons, service worker, HTTPS in
  prod via Caddy).
- The install prompt only appears in browsers + contexts that fire
  `beforeinstallprompt` (Chrome, Edge, Android). iOS Safari adds
  via Share → Add to Home Screen as usual; the apple meta tags are
  in `index.html` for that path.

---

## [0.11.3] — 2026-05-23 — Scheduled background sync (Phase 8.3)

Final Phase 8 release. **Closes Phase 8.** With this slice every
connectivity option from the original roadmap is live and can run
unattended: file imports (OFX/QFX/QIF), OFX Direct Connect, Plaid,
and now scheduled background sync.

### The scheduler

- New `server/src/domain/auto-sync.ts` — same in-process pattern as
  `backup-scheduler.ts`. 60s tick reads settings on every iteration
  so config changes take effect without a restart. The tick reads
  `AUTO_SYNC_ENABLED`; if false, immediate no-op.
- `runAutoSyncTick({force, ofxFetchOverride, plaidFetchOverride})`
  is the exported entry point. The interval calls it with no opts;
  the `/api/auto-sync/run` route calls it with `force:true`; tests
  drive it directly with mocked fetches.
- Per-tick flow:
  1. Read `AUTO_SYNC_ENABLED`. No-op when false.
  2. For daily/weekly cadence: gate on `AUTO_SYNC_TIME` — like the
     backup scheduler, wait until the scheduled instant has passed
     today. Hourly bypasses this gate.
  3. Walk every `ofx_dc_connections WHERE enabled = true`, filter
     down to sources whose `last_sync_at` is older than the
     per-cadence threshold (`shouldRunForSource()`), then call
     `ofxDirectConnectSource.fetch()` + `persistBatch()` and
     update `last_sync_*` on success or failure.
  4. Same for `plaid_items WHERE status = 'active'` — using the
     `fetchPlaidItemTransactions()` helper that already handles the
     per-account fan-out + cursor advance.
- **Per-source error isolation**: each connection / item gets its
  own try/catch. A failing source records `last_sync_status` +
  `last_sync_error` on its row; the tick moves on to the next
  source without blocking. The result object reports per-source
  attempt / success / fail counts so the operator can spot drift.
- **Per-source cadence**: even when the tick runs, sources whose
  `last_sync_at` is recent enough are skipped. Hourly cadence
  tolerates jitter (59-minute floor for "just over 60 min").

### Settings (super-only)

- `AUTO_SYNC_ENABLED` (bool) — global on/off.
- `AUTO_SYNC_FREQUENCY` (`hourly` | `daily` | `weekly`) — cadence
  applied per source.
- `AUTO_SYNC_TIME` (HH:MM, 24h) — scheduled instant for daily /
  weekly cadence. Interpreted in the container's local timezone
  (same caveat as `BACKUP_TIME`).

### Routes

- `GET /api/auto-sync/status` (super-admin) — returns enabled +
  frequency + time + counts of registered OFX-DC + Plaid sources.
- `POST /api/auto-sync/run` (super-admin) — `runAutoSyncTick({force:true})`
  for an immediate fire, useful right after wiring up the first
  bank connection.

### Web (`/system` super-admin panel)

- New `AutoSyncSection` component on the System Overview tab.
  Enable toggle, frequency dropdown, time field, "Save" + "Run
  all syncs now" buttons, plus a source-count summary. Save writes
  through the existing `/api/settings/:key` plumbing — no new
  settings code path.

### Tests (+15 server)

- `tests/unit/auto-sync-cadence.test.ts` — 7 tests for
  `shouldRunForSource`: NULL last-sync, hourly within / past
  window, hourly jitter tolerance, daily threshold, weekly
  threshold, unknown-frequency fallback.
- `tests/integration/auto-sync.test.ts` — 8 tests: no-op when
  disabled, force bypasses the gate, OFX-DC sync persists +
  updates status, per-source failures don't block siblings, the
  cadence gate skips recently-synced sources, an OFX-DC + Plaid
  tick fires both, `/api/auto-sync/status` is super-admin gated,
  `/api/auto-sync/run` runs and returns the result shape.
- Total: **482 tests** (476 server + 6 web), all green.

### Files

```
server/src/domain/auto-sync.ts                  (new)
server/src/routes/auto-sync.ts                  (new)
server/src/domain/settings.ts                   (+AUTO_SYNC_* keys)
server/src/app.ts                               (register routes + boot scheduler)
server/tests/unit/auto-sync-cadence.test.ts     (new)
server/tests/integration/auto-sync.test.ts      (new)
web/src/api.ts                                  (autoSyncStatus / autoSyncRunNow)
web/src/components/AutoSyncSection.tsx          (new)
web/src/pages/SystemPage.tsx                    (mount AutoSyncSection)
```

---

## [0.11.2] — 2026-05-23 — Plaid integration (Phase 8.2)

Third Phase 8 release. Adds Plaid as a third data source — same
`TransactionDataSource` interface as OFX-DC, different backend — but
gated behind a super-admin toggle and **disabled by default**.

Plaid is the only data source that leaves the fully-local model:
turning it on means bank credentials and statement traffic go through
Plaid's servers. The roadmap called this out explicitly, so the
on-by-default story stays "your data stays on your machine"; Plaid
exists for users who actively opt in to the trade-off.

### Gate

- New super-only settings: `PLAID_ENABLED` (bool), `PLAID_CLIENT_ID`,
  `PLAID_SECRET`, `PLAID_ENV` (sandbox / development / production).
- `getPlaidConfig()` returns null unless all four are populated and
  PLAID_ENABLED is truthy. Every route + data-source code path
  consults this gate first.
- `GET /api/plaid/status` is the only Plaid endpoint that works when
  disabled — returns `{enabled: false, environment: null}`. The web
  UI uses this to decide whether to even render the Plaid block.

### Schema (migration 023)

- **`plaid_items`** — one row per Plaid item (= one user@institution
  login). Stores `plaid_item_id`, `institution_id`,
  `institution_name`, AES-256-GCM-encrypted `access_token_encrypted`,
  `sync_cursor`, `status`, and the same `last_sync_*` columns as
  OFX-DC for consistent status surfacing.
- **`plaid_account_links`** — maps a Plaid account_id to a SmrtCash
  account_id within an item. UNIQUE(plaid_item_id, plaid_account_id)
  so re-running the mapping is idempotent.

### Plaid client (`server/src/domain/plaid.ts`)

- Hand-rolled REST wrapper. No SDK — global `fetch`, JSON in / JSON
  out. Endpoints used: `/link/token/create`,
  `/item/public_token/exchange`, `/accounts/get`,
  `/transactions/sync`, `/item/remove`.
- Categorized error types: `auth_failed` (INVALID_CLIENT_ID,
  INVALID_SECRET, INVALID_ACCESS_TOKEN, ITEM_LOGIN_REQUIRED),
  `invalid_request`, `rate_limited` (HTTP 429), `http_error`,
  `transport_error` (fetch reject / timeout).
- `mapPlaidTransaction()` — handles the sign flip: Plaid uses
  positive = outflow, SmrtCash uses negative = outflow, so amounts
  are inverted at the boundary. Falls back to `name` when
  `merchant_name` is absent. Surfaces pending status into memo.

### Data source (`server/src/datasource/plaid.ts`)

- Implements `TransactionDataSource`. Paginates `/transactions/sync`
  starting from the stored cursor until `has_more=false` (max 50
  pages safety guard).
- `fetchPlaidItemTransactions()` returns transactions GROUPED BY
  SmrtCash account via the link table — this is the shape the route
  needs because one Plaid item can fan out to multiple SmrtCash
  accounts.
- Unmapped Plaid accounts are tracked separately and reported in
  the sync response so the user knows to map them.

### Routes (`server/src/routes/plaid.ts`)

- `GET    /api/plaid/status` — public to authenticated users.
- `POST   /api/plaid/link-token` — creates the link_token for the
  browser widget. Admin only.
- `POST   /api/plaid/exchange` — accepts the public_token from
  Plaid Link, exchanges for access_token + item_id, fetches the
  account list, persists encrypted. Admin only.
- `GET    /api/plaid/items` — list items + their account links.
- `POST   /api/plaid/items/:id/link-account` — bulk-write the
  Plaid → SmrtCash account mappings. Admin only.
- `POST   /api/plaid/items/:id/sync` — run a full sync. Calls
  `persistBatch()` per linked account so dedup + counters work
  identically to file imports and OFX-DC. Admin + spouse.
- `DELETE /api/plaid/items/:id` — best-effort calls Plaid's
  `/item/remove` (stops billing in production), then deletes the
  local row. Admin only.

### Web

- New `PlaidSection.tsx` component. Renders only when status
  reports enabled.
- "Connect via Plaid" button — loads the Plaid Link script from
  `cdn.plaid.com` on-demand the first time it's clicked. The
  script is the only external JS in the entire SPA and only loads
  when the user actively initiates a connection.
- Post-exchange: account-mapper modal lets the user pick which
  SmrtCash account each Plaid account routes to (with "Skip"
  option per account).
- Items table: Institution / linked accounts / last-sync / status
  pill / per-row Sync / Remove buttons.

### Importer / persistence

- `import_batches.format_id` now sees `'plaid'` as a value
  alongside `'csv'`, `'xlsx'`, `'ofx'`, `'qfx'`, `'qif'`, `'ofx_dc'`.
  No schema change needed — it's a free-text column.

### Tests (+17 server)

- `tests/unit/plaid-client.test.ts` — 8 tests: host routing, body
  shape (client_id + secret + payload), `auth_failed` on
  INVALID_CLIENT_ID, `rate_limited` on HTTP 429, transport rejection,
  cursor passthrough, amount-sign inversion, fallback to `name`
  when `merchant_name` absent.
- `tests/integration/plaid.test.ts` — 9 tests: status off/on, gate
  rejects link-token when disabled, happy-path link-token,
  exchange + DB encryption check (token not stored in plaintext),
  account mapping, full sync (transaction lands on mapped
  SmrtCash account, cursor advances, status flips to ok), sync
  surfaces auth_failed, DELETE calls /item/remove and removes the
  row.
- Total: **467 tests** (461 server + 6 web), all green.

### Files

```
server/src/db/migrations/023_phase8_2_plaid.sql       (new)
server/src/domain/plaid.ts                            (new)
server/src/domain/settings.ts                         (+PLAID_* keys, getPlaidConfig)
server/src/datasource/plaid.ts                        (new)
server/src/routes/plaid.ts                            (new)
server/src/app.ts                                     (register routes)
server/tests/setup/test-db.ts                         (TRUNCATE plaid_*)
server/tests/unit/plaid-client.test.ts                (new)
server/tests/integration/plaid.test.ts                (new)
web/src/api.ts                                        (Plaid types + methods)
web/src/components/PlaidSection.tsx                   (new)
web/src/pages/ConnectionsPage.tsx                     (mount PlaidSection)
```

---

## [0.11.1] — 2026-05-23 — OFX Direct Connect (Phase 8.1)

Second Phase 8 release. Wires the first concrete
`TransactionDataSource` on top of the OFX parser from 0.11.0 —
pulling statements straight from a bank's OFX endpoint with no
aggregator and no per-bank data sharing.

### Schema (migration 022)

- **`ofx_dc_connections`** — tenant-scoped. Stores bank coordinates
  (`ofx_url`, `ofx_org`, `ofx_fid`, `ofx_app_id`, `ofx_app_version`,
  optional `intu_bid`), account routing (`bank_acct_id` +
  `bank_acct_type` ∈ {CHECKING, SAVINGS, MONEYMRKT, CREDITLINE,
  CREDITCARD} + nullable `bank_id`), and **encrypted credentials**
  (`username_encrypted`, `password_encrypted`, both `bytea`). Sync
  state lives on the row: `last_sync_at`, `last_sync_status`,
  `last_sync_error`, `last_sync_imported`, `last_sync_skipped`.

### Encryption

- New `server/src/domain/crypto.ts` exports `encryptString` /
  `decryptString` — same AES-256-GCM wire format as attachments
  (`[12-byte IV][ciphertext][16-byte GCM tag]`) under the same
  `ATTACHMENT_ENCRYPTION_KEY`. Refuses to operate if the key is
  unset; bank passwords never sit in plaintext at rest.

### Protocol

- New `server/src/domain/ofx-dc.ts`:
  - `formatOfxDateTime(d)` → `YYYYMMDDHHMMSS` in UTC.
  - `buildOfxStmtRequest({connection, startDate, endDate})` →
    OFX 1.x SGML request body. Speaks **VERSION:102** (broadest
    bank support); the SGML parser from 0.11.0 happily reads
    either 1.x or 2.x responses. Builds `BANKMSGSRQV1` or
    `CREDITCARDMSGSRQV1` based on `bankAcctType`, escapes
    SGML-significant chars in credentials, includes optional
    `<INTU.BID>` when set.
  - `postOfxRequest(url, body, {fetchImpl?, timeoutMs?})` — POSTs
    with `Content-Type: application/x-ofx`, 60s default timeout,
    injectable `fetch` for unit tests.
  - `fetchOfxStatement(req, opts)` — one-shot: build + post +
    parse. Inspects `SONRS` status code: non-zero 15500-range →
    `OfxDcError('auth_failed')`, other non-zero → `'parse_error'`.
    Other failure kinds: `'http_error'`, `'transport_error'`.

### Data source

- New `server/src/datasource/ofx-direct-connect.ts` —
  `ofxDirectConnectSource` implements `TransactionDataSource`.
  `fetch()` loads the row, decrypts credentials, computes the
  incremental window (`last_sync_at - 7 days` for re-syncs, last
  90 days on first sync), calls the protocol module, returns
  `ParsedTransaction[]` + an updated cursor.

### Routes

- New `server/src/routes/ofx-dc.ts`:
  - `GET    /api/ofx-dc/connections` — list (encrypted columns
    stripped from the response).
  - `POST   /api/ofx-dc/connections` — create (admin only).
  - `PATCH  /api/ofx-dc/connections/:id` — update; blank password
    keeps the current value.
  - `DELETE /api/ofx-dc/connections/:id`.
  - `POST   /api/ofx-dc/connections/:id/test` — 1-day window probe.
    Available to admin + spouse.
  - `POST   /api/ofx-dc/connections/:id/sync` — real fetch; on
    success runs through the shared `persistBatch()` (same dedup
    code path as file imports). Updates `last_sync_*` columns on
    both success and failure.

### Importer refactor

- `import/importer.ts` now exports `persistBatch()` so the
  data-source layer can reuse the CSV / structured / direct-connect
  persistence path — single source of truth for dedup hashing +
  `import_batches` rows + `ON CONFLICT DO NOTHING` semantics.

### Web

- New `web/src/pages/ConnectionsPage.tsx` and `/connections` route
  in the tenant sidebar. Form for add/edit (with help text pointing
  at ofxhome.com), table of existing connections, per-row
  **Test** / **Sync now** / **Edit** / **Delete**. Status pills:
  OK / Never / Auth failed / HTTP error / Parse error / Transport
  error. `last_sync_error` text shown inline when present.
- API types: `OfxDcConnection`, `OfxDcConnectionInput`,
  `OfxDcActionResult`, `OfxDcAccountType`.

### Tests (+25 server)

- `tests/unit/crypto.test.ts` — 5 tests: round-trip, IV uniqueness,
  truncation rejection, tag-tamper rejection, unicode + long
  strings.
- `tests/unit/ofx-dc.test.ts` — 9 tests: date formatter, request
  building (bank + credit-card + SGML escaping + INTU.BID), happy
  path with mocked fetch, `auth_failed` on SONRS 15500, HTTP 500
  mapping, transport rejection.
- `tests/integration/ofx-dc.test.ts` — 11 tests: CRUD shape,
  credential encryption (DB doesn't contain plaintext), GET
  excludes encrypted columns, `bankAcctType` allow-list, PATCH
  re-encryption, `/test` happy + auth-failed paths, `/sync`
  happy path (transaction lands on the account, status row
  updates to 'ok'), `/sync` failure path (status row updates to
  'auth_failed' with error text), `/sync` dedup on second pass.
- Total: **450 tests** (444 server + 6 web), all green.

### Files

```
server/src/db/migrations/022_phase8_1_ofx_direct_connect.sql   (new)
server/src/domain/crypto.ts                                    (new)
server/src/domain/ofx-dc.ts                                    (new)
server/src/datasource/ofx-direct-connect.ts                    (new)
server/src/routes/ofx-dc.ts                                    (new)
server/src/app.ts                                              (register routes)
server/src/import/importer.ts                                  (export persistBatch)
server/tests/setup/test-db.ts                                  (TRUNCATE ofx_dc_connections)
server/tests/unit/crypto.test.ts                               (new)
server/tests/unit/ofx-dc.test.ts                               (new)
server/tests/integration/ofx-dc.test.ts                        (new)
web/src/api.ts                                                 (OFX-DC types + methods)
web/src/pages/ConnectionsPage.tsx                              (new)
web/src/App.tsx                                                (nav + route)
```

---

## [0.11.0] — 2026-05-23 — File-import expansion (Phase 8.0)

First Phase 8 release. Three new import formats join CSV/XLSX —
covering the Quicken / Banktivity / Moneydance migration path — and a
pluggable data-source layer goes in as the cornerstone for 8.1
(OFX Direct Connect), 8.2 (Plaid), and 8.3 (scheduled sync).

### New parsers

- **QIF (Quicken Interchange Format)** — `server/src/import/parsers/qif.ts`.
  Walks `!Type:Bank` / `CCard` / `Cash` / `Oth A` / `Oth L` sections,
  records terminated by `^`. Accepts all common date shapes including
  Quicken's apostrophe-year (`1/3'05` → 2005-01-03) and 2-digit slash
  years (pivot: `<70` → 2000s, `≥70` → 1900s). N (reference / check
  number) is rolled into memo. Ignored sections (`!Account`,
  `!Type:Cat`, investment, securities) are skipped without crashing.
- **OFX 1.x (SGML) + OFX 2.x (XML) + QFX** — `server/src/import/parsers/ofx.ts`.
  A tolerant SGML parser that handles both styles: explicit close
  tags (OFX 2.x) and the SGML quirk where leaf elements omit their
  close tag and text terminates at the next `<` (OFX 1.x). Walks
  every `STMTTRN` node anywhere in the tree, so bank statements,
  credit-card statements, and investment statements all work.
  Pulls `TRNTYPE` / `DTPOSTED` / `TRNAMT` / `NAME` / `MEMO` /
  `CHECKNUM` / `FITID`. QFX is detected by the `.qfx` extension
  and labelled as such; the parser is otherwise identical to OFX.

### Pipeline wiring

- New module `server/src/import/structured.ts` exports
  `tryParseStructured(filename, buffer)`. The importer calls this
  first; if it returns a result, the CSV/XLSX path is skipped
  entirely. Routing is by file extension (`.ofx`, `.qfx`, `.qif`)
  with a content-sniff fallback for OFX (so files with weird
  extensions still work).
- `importer.ts` was refactored so both CSV/XLSX and structured
  imports share a single `persistBatch()` helper — dedup hashing,
  the `import_batches` insert, the per-row transaction insert with
  `ON CONFLICT (account_id, dedup_hash) DO NOTHING`, and the batch
  counters all live in one place now.
- `/api/imports/formats` now advertises `ofx` / `qfx` / `qif` so the
  Import page's format dropdown lists them alongside Chase.
- Same `POST /api/imports/preview` and `POST /api/imports/commit`
  endpoints — no new routes.

### Data-source layer scaffold

- New directory `server/src/datasource/` with `types.ts` and
  `registry.ts` defining the `TransactionDataSource` interface that
  the rest of Phase 8 plugs into. The shape mirrors Phase 2's
  `TransactionNormalizer` and Phase 3's `OcrProvider` — `id`,
  `name`, `fullyLocal`, `configKeys`, and an async `fetch()` that
  returns `ParsedTransaction[]` + `RowError[]` + an opaque cursor
  for incremental sync. No data sources are registered yet; the
  scaffold sits ready for 8.1.

### Web

- Import page's file picker accepts `.csv`/`.xlsx`/`.ofx`/`.qfx`/`.qif`.
- Header help text reflects the new format list.
- No other UI changes — the existing preview + commit + dedup flow
  works unmodified because structured imports return the same
  `ImportPreview` / `ImportResult` shapes as CSV/XLSX.

### Tests

- `tests/unit/qif-parser.test.ts` — 7 tests: canonical fixture
  round-trip, trailing record without `^`, ignored sections,
  per-record error isolation, apostrophe + 2-digit-year dates,
  garbage-date rejection.
- `tests/unit/ofx-parser.test.ts` — 6 tests: OFX 1.x SGML, QFX,
  OFX 2.x XML, content sniffing, OFX date parser, missing-root
  rejection.
- `tests/integration/imports-structured.test.ts` — 7 tests
  exercising the full `/api/imports/preview` + `/api/imports/commit`
  + `/api/imports/formats` path for QIF / OFX 1.x / OFX 2.x / QFX,
  including dedup on re-import.
- Total: **425 tests** (419 server + 6 web), all green.

### Files

```
server/src/datasource/types.ts                          (new)
server/src/datasource/registry.ts                       (new)
server/src/import/parsers/qif.ts                        (new)
server/src/import/parsers/ofx.ts                        (new)
server/src/import/structured.ts                         (new)
server/src/import/formats.ts                            (advertises ofx/qfx/qif)
server/src/import/importer.ts                           (structured-first routing)
server/tests/fixtures/sample.qif                        (new)
server/tests/fixtures/sample.ofx                        (new)
server/tests/fixtures/sample.qfx                        (new)
server/tests/fixtures/sample-ofx2.ofx                   (new)
server/tests/unit/qif-parser.test.ts                    (new)
server/tests/unit/ofx-parser.test.ts                    (new)
server/tests/integration/imports-structured.test.ts     (new)
web/src/pages/ImportPage.tsx                            (accept list + help text)
```

---

## [0.10.1] — 2026-05-23 — Retirement projections (Phase 7.2)

Closes Phase 7. The last queued item from the original roadmap lands:
forward-looking projections of long-term goals.

### Schema (migration 021)

- **`retirement_projections`** — one row per "what-if" model:
  name, starting balance, monthly contribution, annual return %,
  optional inflation deflator, horizon years (1–100), optional
  target year + target amount. Tenant-scoped via the standard
  `tenant_id`.

### Domain

- **`domain/projections.ts#computeProjection()`** — pure math.
  Monthly-compound on the annual return rate
  (`(1 + annual_return/100)^(1/12) - 1`), with end-of-month
  contributions then end-of-month growth. Emits one point per year
  (year 0 = starting state) with both nominal and real (inflation-
  deflated) projected balance.

### Routes

- `GET /api/projections` — list (tenant-scoped).
- `POST /api/projections` — create.
- `PATCH /api/projections/:id` — update.
- `DELETE /api/projections/:id` — remove.
- `GET /api/projections/:id/series` — compute the year-by-year curve.

### Web

- **`/retirement` page** with a sidebar of projections + detail pane.
  Detail shows a Recharts line chart with the nominal curve (and a
  real-dollar curve when inflation > 0), a target reference line
  when configured, a summary line, and an inline tune form for
  adjusting contributions / return / inflation / horizon.

### Tests

- `+8` integration tests (`projections.test.ts`): math (0%-flat,
  10% growth band, inflation deflation, negative return compounds),
  CRUD (create + list + series, validation, PATCH + DELETE).
- **Total: 405** (server 399 + web 6).

### Notes

- Real-terms math uses straight `nominal / (1 + infl)^year`. Monte
  Carlo with return variance is on the backlog but overkill for a
  household app.
- Starting balance is captured at creation time and editable via
  PATCH — a projection is a comparison artifact, not a live
  forecast against changing accounts.

---

## [0.10.0] — 2026-05-23 — Multi-currency (Phase 7.1)

The first of two queued Phase-7 items lands. Accounts can now be in
any ISO 4217 currency; the dashboard converts every balance into a
shared display currency for cross-account totals.

### Schema (migration 020)

- **`exchange_rates`** table — one row per (from, to, fetched_at).
  History is kept; lookups pick the most-recent row per pair via a
  `DISTINCT ON (from, to)` ORDER BY fetched_at DESC.
- New settings: `DISPLAY_CURRENCY` (ISO 4217, default 'USD') and
  `FX_PROVIDER` ('open-er-api' for the auto-refresher). Both
  super-admin-only.

### Domain

- **`domain/fx.ts`** — `convert(amountCents, from, to, snapshot)`
  resolves a rate (direct lookup, inverse fallback at 1/rate, or
  pass-through when neither known) and returns cents in the target
  currency plus a `rateKnown` flag for UI.
- **`refreshRatesFromOpenErApi()`** — pulls fresh rates from the
  free `open.er-api.com/v6/latest/<base>` endpoint and writes one
  row per non-base target. No API key required; the IP rate-limit is
  generous (daily refresh well within it).
- **`setManualRate()`** — operator override, stored with
  `source='manual'`. Manual rows aren't preferred — the most-recent
  row per pair wins regardless of source, so writing a manual rate
  effectively pins it until the next refresh.

### Routes

- `GET /api/exchange-rates` — readable by any authenticated user
  (the dashboard needs it); returns latest rate per pair plus the
  display currency.
- `POST /api/exchange-rates/refresh` — super-admin only.
- `POST /api/exchange-rates` — set a manual rate.
- `DELETE /api/exchange-rates/:from/:to` — drop all rows for a pair.
- **`GET /api/accounts`** now attaches `display_currency`,
  `balance_display_cents`, and `rate_known` to every account row.
  Net-worth-style aggregations across mixed currencies just sum
  `balance_display_cents`.

### Web

- **`/system`** Overview tab gets an Exchange rates section under
  Super admins: rate table with source pill, "Refresh from provider"
  button, and a manual-override form.
- **Accounts page** sums `balance_display_cents` for the Net Worth
  stat and labels the value with the display currency when accounts
  use multiple currencies. A warning banner appears when any
  account's currency has no rate configured.

### Tests

- `+7` integration tests (`fx.test.ts`): tenant can read but not
  mutate, manual rate persistence, validation (negative rate, same
  from/to), accounts-list projection (direct + inverse + unknown),
  pair delete.
- **Total: 397** (server 391 + web 6).

### Notes

- Per-transaction currency conversion isn't done yet — every
  transaction is in its account's currency. Cross-currency totals
  use account-level balances (already-summed cents) projected at the
  current rate, which is the right tradeoff for a household app.
- `open.er-api.com` is the only auto-provider wired today;
  `frankfurter` is in the source-CHECK constraint but not yet
  fetched. Manual rates cover any gap.

---

## [0.9.5] — 2026-05-23 — Frontend design refresh + dark mode

Pure styling slice — token system overhaul, polished components,
proper dark mode with a sidebar toggle. No JSX class-name changes;
no backend touched.

### Added

- **Token-driven design system** in `styles.css`:
  `--surface-1/2/3`, `--border` + `--border-strong`,
  `--text/muted/dim`, `--accent`/`--accent-soft`,
  `--pos/neg/warn/info` (each with a tinted `-soft` variant),
  `--shadow-sm/shadow/shadow-lg`, `--radius-sm/radius/radius-lg`.
  Legacy alias names (`--bg`, `--card`, `--accent-dark`) are kept
  so older rules keep working.
- **Dark mode** via `:root[data-theme="dark"]` overrides. `main.tsx`
  applies the attribute from `localStorage` before the React tree
  mounts → no flash of light theme on reload.
- **`ThemeToggle` component** in both sidebar footers
  (tenant + super admin). Two-button segmented control.

### Changed

- **Sidebar**: indigo→emerald brand gradient on `SmrtCash`,
  background gradient, active link gets a left accent bar instead of
  a solid pill background, subtle hover states.
- **Page header**: bumped `h1` to 26px with tighter tracking, refined
  subtitle color and line-height.
- **Buttons**: primary uses the new indigo `--accent`, secondary has
  a clean outlined treatment, danger restraint until hover.
  `btn-link` gets a soft tinted hover background.
- **Inputs**: 3px accent-soft focus ring, dark-mode-aware
  backgrounds + borders.
- **Tables**: uppercase letter-spaced header row over `--surface-3`,
  hover row gets `--surface-3`, selected row gets `--accent-soft`,
  tabular numerics on numeric columns.
- **Banners + status pills**: use the new `--{pos,neg,warn,info}-soft`
  backgrounds with `color-mix` borders for a consistent semantic
  palette in both themes.
- **Auth screens** get a soft radial-gradient backdrop and a
  shadow-lg card, with the brand letterform in the gradient style.
- **Code chips** + scrollbars themed.

### Notes

- The redesign deliberately keeps every existing class name so React
  components don't need to change. Source-order overrides at the
  bottom of `styles.css` carry the new visual treatment.
- Inter is preferred but not bundled — the system stack picks up
  fluently if it's not installed.

---

## [0.9.4] — 2026-05-23 — Scheduler fix, GUI restore, secondary backup destination, env snapshot, savings % overrides

Five related items, all backup-or-budget. Headline: the scheduler bug
that prevented scheduled backups from firing is fixed.

### Fixed

- **Scheduler not firing** (regression from 0.7.6 onward). The tick
  required an EXACT hour-and-minute match against `BACKUP_TIME`;
  `setInterval` drift meant the daily window was reliably missed. The
  new logic uses a "scheduled instant has passed today" predicate
  combined with the cadence gate (`shouldRun`), which is robust to
  60s jitter. Timezone note: `BACKUP_TIME` is interpreted in the
  container's local time (UTC by default in Docker — set the `TZ` env
  var in compose to schedule against a different zone).

### Added

- **Restore from the GUI**. New `POST /api/backups/:id/restore`
  endpoint (super-admin only). Requires `confirm: 'RESTORE'` in the
  body. Runs `pg_restore --clean --if-exists` against the live
  database, then extracts attachments. The `/backups` page gets a
  **Restore** action on each success row that prompts for the
  confirmation token via `window.prompt`.
- **Secondary off-server backup destination**. New setting
  `BACKUP_SECONDARY_DIR` (super-only). After every successful primary
  backup, the timestamped folder is copied (via `fs.cp`) to this
  path. Works with any mountable filesystem (NFS, CIFS, USB, S3
  via s3fs/rclone-mount, etc.) — no new dependency on the box.
  Failure of the secondary copy is recorded as a warning on the
  backup row without failing the primary.
- **env.snapshot.json in every backup**. `app_settings` rows are
  inside `db.dump` (everything in the DB is captured). The new
  `env.snapshot.json` captures process.env values for every key in
  `KNOWN_SETTINGS` at the moment of backup — covers the env-var
  fallback path so a full host wipe + restore can put `.env` back.
- **Savings percentage overrides in the Budget Wizard**. Two new
  inputs on the wizard form — "Savings % of income" and "Savings %
  of leftover" — let the tenant admin override the global defaults
  per wizard run. Empty fields fall back to the platform-wide
  `SAVINGS_INCOME_PCT` / `SAVINGS_LEFTOVER_PCT`. Backend accepts
  `savingsIncomePctOverride` and `savingsLeftoverPctOverride` on
  `POST /api/budgets/wizard/preview` and `/commit`.

### Tests

- `+7` integration tests (`backup-restore-env.test.ts`): restore
  requires the literal confirm token; missing dump returns a clear
  error; tenant admin gets 403; non-success rows can't be restored;
  `secondary_directory` surfaces on `/api/backups/config`; wizard
  honors per-run % overrides; out-of-range overrides fall back.
- **Total: 390** (server 384 + web 6).

### Notes

- The restore endpoint runs `pg_restore` while the server is live.
  Open sessions stay alive but every tenant sees the snapshot's data
  on their next read. Restart-after-restore is recommended for a
  clean state — the success message says so.
- Off-server backends beyond "secondary path" (native S3, SFTP) are
  a follow-up — `cp` to a mounted share covers the bulk of self-host
  setups.

---

## [0.9.3] — 2026-05-23 — AI + EIA settings move to super-admin; tenant Settings page removed

All app settings are now platform-level. Tenant admins have nothing
left to configure on `/settings`, so the page (and its sidebar entry)
disappear from their view entirely. Super admin keeps full access.

### Changed

- **`KNOWN_SETTINGS`** — `AI_PROVIDER`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_MODEL`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `EIA_API_KEY`,
  `SAVINGS_INCOME_PCT`, `SAVINGS_LEFTOVER_PCT` all flip to
  `superOnly: true`. Combined with the 0.9.1 + 0.9.2 changes, EVERY
  known setting is now super-admin only.
- **`/api/settings/ai-models`** gated to super admin (was open before
  for the tenant Settings page's model picker — but tenants don't see
  the page anymore).
- **`/settings` nav link removed from tenant sidebar.** The route is
  also gone from the tenant `<Routes>` block. Hitting `/settings`
  manually as a tenant user lands on the dashboard (no router match).
- Super admin keeps `/settings` in their sidebar and routes; they see
  every setting.

### Rationale

- One Anthropic API key for the box is consistent with how the AI
  pipelines were already written.
- EIA fuel prices are a fetcher used by every tenant; per-tenant
  configuration would split the rate-limited free quota and add
  configuration burden.
- Savings tuning is read by the budget wizard as a global default.
  Per-tenant overrides land in a future slice when the demand is
  clearer.

### Tests

- `+2` integration tests in `rbac.test.ts`: tenant gets 403 on
  PUT `/api/settings/AI_PROVIDER` and GET `/api/settings/ai-models`.
- `settings.test.ts`, `commute-routes.test.ts`, and the existing
  rbac tests updated to assert the empty-tenant view and to thread a
  super-admin cookie through every AI/EIA-touching call.
- The "tenant admin GET" assertion now expects an empty array, not a
  filtered list.
- **Total: 383** (server 377 + web 6).

### Notes

- Per-tenant AI + EIA overrides remain on the table for a future
  slice — the foundation is the same (`tenant_settings` table + a
  helper that prefers tenant-scoped values), just deferred until
  there's demand.

---

## [0.9.2] — 2026-05-23 — Auth providers move to super-admin

Auth provider configuration is a platform-operator concern — deciding
which login methods exist (Google / Microsoft / GitHub / generic OIDC)
isn't something a tenant admin should be able to do on their own
shared instance.

### Changed

- **`/api/auth-provider-configs/*`** (GET/POST/PATCH/DELETE) — gated
  to super admin. Tenant admins get 403 across the board.
- **`/workspace`** drops its Auth providers section entirely.
- **`/system`** Overview tab gains the Auth providers section
  (extracted into `components/AuthProvidersSection.tsx` and rendered
  below Super admins).

### Tests

- `+2` integration tests in `multi-tenant.test.ts`: tenant admin gets
  403 on POST and GET. The existing CRUD test now uses a super-admin
  cookie throughout.
- DELETE-test gotcha: Fastify rejects `DELETE` requests when
  `content-type: application/json` is set with no body — pass cookie
  only on DELETE.
- **Total: 381** (server 375 + web 6).

---

## [0.9.1] — 2026-05-23 — Health, backups, SMTP, security keys: super-admin only

Tightens the 0.9.0 RBAC boundary. Anything platform-level moves out of
tenant-admin reach.

### Changed

- **`/api/health/*`** (metrics, timeseries, live) — tenant-admin gets
  403; super-admin gets the data.
- **`/api/backups/*`** (list, config, run, prune, delete) — same.
- **`/api/admin/smtp-test`** — same.
- **`/api/admin/restart`** — same. Was loosely gated before; now
  explicitly super-admin only.
- **`/api/settings`** is filtered server-side by the requester's
  context:
  - Tenant admin sees AI provider keys, EIA, and Savings tuning.
  - Super admin sees everything plus SMTP, BACKUP_*, APP_BASE_URL,
    SESSION_SECRET, ATTACHMENT_ENCRYPTION_KEY.
- PUT/DELETE on a super-only key returns 403 to a tenant admin even
  if they construct the URL by hand.

### Removed (from tenant sidebar)

- Health, Backups (super-admin sidebar already has them).
- Settings page now skips entire sections (SMTP, Security) when the
  server doesn't return any of their keys, so tenant admins see a
  trimmed Settings view focused on what they can actually change.

### Notes

- Capability-tagged settings via a new `superOnly: boolean` field on
  `KNOWN_SETTINGS`. Adding a new super-only setting is now one
  metadata field, not a route-by-route edit.
- The `requireSuperAdmin(req, reply)` guard moved to
  `auth/rbac.ts` so health, backups, settings, and system routes all
  share one implementation.

### Tests

- `+3` integration tests in `rbac.test.ts`: tenant blocked from
  PUTting SMTP_HOST and BACKUP_ENABLED; GET /api/settings hides
  super-only keys.
- `health-backups-reports.test.ts` rewritten to assert tenant 403 +
  super-admin 200 paths via a new `makeSuperAdminCookie()` helper.
- `smtp.test.ts` adds a 403 check and threads super-cookies through
  the verify-stage tests.
- `settings.test.ts` updated to split tenant-visible / super-visible
  expectations and use the super cookie on SESSION_SECRET /
  ATTACHMENT_ENCRYPTION_KEY writes.
- **Total: 379** (server 373 + web 6).

---

## [0.9.0] — 2026-05-23 — RBAC: super admins, tenant admin/spouse/child, audit log

Role model overhaul. Three orthogonal concepts:

1. **Super admin** — platform operator. Manages tenants, system
   settings, audit log. Orthogonal to tenant membership: a super admin
   never has a `memberships` row, enforced by trigger.
2. **Tenant role** — `admin` / `spouse` / `child` (replaces
   `owner` / `admin` / `member` / `viewer`).
3. **Per-account ACL** — children are scoped to admin-assigned accounts
   only.

### Schema (migration 019)

- **`users.is_super_admin`** boolean. Two CHECK triggers enforce
  super-admin-has-no-memberships in both directions:
  - inserting a membership for a super-admin user fails
  - flipping `is_super_admin=true` on a user with memberships fails
- **`memberships.role` collapsed**:
  - `owner` → `admin`
  - `admin` → `admin`
  - `member` → `spouse`
  - `viewer` → `child`
  - new CHECK enforces the set
- **`invitations.role`** likewise rewritten.
- **`account_user_access`** — per-tenant child ACL. PK
  `(account_id, user_id)`; cascade-deletes when the account or user is
  removed.
- **`audit_log`** — append-only record of mutating actions. Fields:
  `occurred_at`, `tenant_id` (null for system), `actor_user_id`,
  `actor_kind` (`super_admin` / `tenant_user` / `system` / `public`),
  `action` (dotted namespace), `target_kind`, `target_id`, `details`
  jsonb. Three indexes for the common query shapes.

### Permissions

| Role          | Read/write financials | Manage members | Manage providers | See settings |
|---------------|-----------------------|----------------|------------------|--------------|
| admin         | ✅                    | ✅             | ✅               | ✅           |
| spouse        | ✅                    | ❌             | ❌               | ❌           |
| child         | scoped only           | ❌             | ❌               | ❌           |
| super admin   | ❌ (never)            | n/a            | n/a              | system-only  |

- **Children** see only accounts assigned via `account_user_access`.
  `GET /api/accounts` filters; `GET /api/transactions` filters list +
  count + ignores out-of-scope `accountId` query params. Other
  endpoints (budgets, bills, etc.) aren't filtered yet — children are
  admin-managed concepts; admins/spouses drive those views. Full
  enforcement everywhere is queued behind RLS (next slice).

### First-user flow

- **Fresh install**: first user via `/setup` becomes a `super_admin`
  with no tenant membership. The Setup page now reads "Create the
  platform operator". They land on `/system` and create tenants from
  there, then invite tenant admins.
- **Upgrade from 0.8.x**: the migration leaves existing owners as
  tenant admins of their existing tenant. No super admin exists by
  default — create one with `npm run create-super-admin --email …
  --password …`. The CLI script reads from `.env` and runs an
  argon2id hash on the host.

### Added

- **`/api/system/*` endpoints** (super-admin only):
  - `GET /api/system/tenants` — counts only, never balances
  - `POST /api/system/tenants`
  - `PATCH /api/system/tenants/:id` (rename)
  - `DELETE /api/system/tenants/:id` (destructive — cascade-deletes
    tenant data)
  - `POST /api/system/tenants/:id/admin-invite` — mints an
    `admin`-role invitation for a new tenant
  - `GET /api/system/audit` — paginated, filterable by tenant +
    action
  - `GET /api/system/users`
  - `POST /api/system/users/super` — create another super admin
- **`/api/tenants/:id/members/:userId/accounts`** GET + PUT — manage
  child-account assignments. Admins only.
- **Audit writes** on: `super_admin.bootstrap`, `super_admin.login`,
  `super_admin.create`, `user.login`, `tenant.create`,
  `tenant.rename`, `tenant.delete`, `tenant.admin_invite`. More
  routes will adopt `recordAudit()` in follow-up slices.
- **Web: `/system` super-admin console** with Overview (tenants,
  super admins) and Audit log tabs. Super-admin sessions see a
  different sidebar that hides the financial app.
- **Web: child-account assignment** — admin clicks "Accounts" on a
  child's row in `/workspace` → modal lists every tenant account
  with checkboxes.

### Tests

- `+10` integration tests (`rbac.test.ts`): trigger enforcement (×2),
  `/api/system` gating + 200 path (×3), child scoping on
  accounts (×2), child scoping on transactions, spouse blocked from
  invites, admin assigns child accounts.
- All previous tests updated to the new role names.
- **Total: 373** (server 367 + web 6).

### Breaking

- Membership role names changed. API consumers expecting
  `owner`/`member`/`viewer` will break — update to
  `admin`/`spouse`/`child`. The migration rewrites existing rows in
  place.
- The fresh-install `/setup` flow now creates a super-admin, not a
  tenant admin. An existing installation upgrading from 0.8.x keeps
  its user as `tenant_admin`.

### Deferred (next slices)

- **RLS enforcement** — `tenant_id` columns are populated but no
  policies are on yet. Today a tenant user could in principle query
  another tenant's data by id (no UI surface lets you, but the
  primary keys are guessable). RLS turns this off platform-wide.
- **Child scoping on remaining endpoints** — budgets, bills,
  attachments, splits, etc. Currently a child UI doesn't surface
  these; backend enforcement is the next defense.
- **Audit writes on every mutating route** — current coverage is
  high-value mutations only. Settings changes, member-role flips, and
  bulk imports will be added incrementally.

---

## [0.8.1] — 2026-05-23 — SMTP for outbound communications

GUI-managed SMTP plumbing with the first use case wired: invitation
emails. Future password resets, bill-due alerts, and backup-failure
notifications slot in as additional `tryMail()` callers.

### Added

- **nodemailer** dependency (server). One transport built on demand
  per send; no persistent connection pool — fine for self-hosted
  volume.
- **`domain/mailer.ts`** — `tryMail()` sends one message, returns
  `{ sent: false, reason }` when SMTP is unconfigured so callers can
  decide between sending and surfacing a "configure SMTP" hint.
  `verifyConnection()` validates the transport for the Test button.
  `renderInvitationEmail()` builds the invitation HTML + text body.
- **New settings keys** (all live, mailer reads on each send):
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (masked secret),
  `SMTP_FROM`, `SMTP_SECURE` (TLS-on-connect for port 465), and
  `APP_BASE_URL` (operator-set base URL for email links — needed for
  headless sends where request headers aren't reliable).
- **`POST /api/admin/smtp-test`** — verifies the connection then
  sends a one-line test email. Owner-only. Reports the failure stage
  (`verify` vs `send`) when it doesn't work.
- **Settings page** gets an SMTP section with all six keys + an
  inline test-send panel that displays the result inline.
- **Invitation create** now sends the invite link via email when SMTP
  is configured AND an `emailHint` was supplied. Best-effort: if the
  send fails, the invite row still exists, the InviteForm stays open
  with the failure reason, and the copy-link button on the row still
  works.

### Tests

- `+4` integration tests (`smtp.test.ts`): test-send 400s without a
  recipient, test-send 400s with reason when SMTP unconfigured, invite
  create still 201s with `email.sent=false` reason, no-hint reports
  the no-hint reason.
- **Total: 363** (server 357 + web 6).

### Notes

- The provided test environment doesn't reach a real SMTP server;
  coverage of the success path will land alongside a future
  vi.mock-based suite or a CI-side fake SMTP fixture.

---

## [0.8.0] — 2026-05-23 — Multi-tenant + multi-user foundation

Headline shift: SmrtCash is no longer a single-user-per-instance app.
This release lays the schema, abstractions, and UI for households /
organizations to share one self-hosted deployment with role-gated
access and pluggable authentication. RLS enforcement and SAML
implementation follow in 0.8.x slices.

### Added — schema (migrations 017 + 018)

- **`tenants`** — one row per household/org. URL-safe slug + display name.
- **`memberships`** — many-to-many users↔tenants with role
  (`owner` / `admin` / `member` / `viewer`).
- **`invitations`** — short-lived URL-safe tokens with role + optional
  email hint, created by owner/admin, accepted by anyone holding the
  link. Tokens expire after 14 days.
- **`user_identities`** — many-to-one identities↔user. One row per
  provider login (`local`, `oidc:google`, `oidc:<slug>`, `saml:<slug>`).
  Lets one user log in via password AND Google AND Microsoft.
- **`auth_provider_configs`** — runtime registry of configured OIDC /
  SAML providers. Settings UI writes here; the login page reads via
  `GET /api/auth/providers`. Local is implicit and always available.
- **users gains `email` + `name`** (unique email); singleton convention
  retired. `password_hash` is now nullable for OIDC-only users.
- **sessions gains `active_tenant_id`** so the session middleware can
  carry tenant context. Set on login + invite-accept; mutable via
  `POST /api/tenants/switch`.
- **`tenant_id` columns** added (nullable, backfilled to the seeded
  `Default` tenant) on every user-data table: accounts, transactions,
  attachments, categories, category_suggestions, import_batches,
  normalization_rules, transaction_splits, recurring_suggestions,
  budgets, savings_goals, bills, recurring_income, holdings, vehicles,
  commute_routes, route_vehicle_assignments, fuel_prices. NOT NULL +
  Row Level Security policies land in a follow-up migration after the
  query audit + test sweep.

### Added — authentication abstraction

- **`AuthProvider` interface** (`auth/providers/types.ts`) — every
  login method implements `begin()` + (`verify()` for credential flows
  OR `completeRedirect()` for OIDC/SAML).
- **Local provider** wraps the existing argon2id flow as one provider
  among many. Always enabled — it's the bootstrap path.
- **Generic OIDC provider** (`auth/providers/oidc.ts`) — full
  Authorization-Code + PKCE flow built on Node 22's `fetch` and
  `crypto`. Reads the IdP discovery document, generates verifier +
  nonce + state, exchanges the code at the token endpoint, validates
  `iss` + `aud` + `nonce`, decodes the ID token, and falls back to
  the userinfo endpoint when needed. Same code path serves the preset
  configs for Google / Microsoft / GitHub (their discovery URLs are
  hardcoded) and any spec-compliant generic OIDC IdP (Okta,
  Authentik, Keycloak, Azure AD, etc).
- **SAML provider** is a stub — interface in place, returns a clear
  "not implemented yet" from `begin()`. A correct SP-initiated flow
  with XML-signature verification needs a vetted library and focused
  tests; queued for 0.8.x.

### Added — routes

- `GET /api/auth/providers` — login page lists configured providers
- `GET /api/auth/oidc/:slug/begin` — kicks off an OIDC redirect with
  a short-lived signed state cookie
- `GET /api/auth/oidc/:slug/callback` — handles the IdP callback
- `POST /api/auth/setup` — now takes `{ email, name?, password }` and
  promotes the new user to owner of the Default tenant
- `POST /api/auth/login` — takes `{ email, password }` (back-compat:
  email-less still works when exactly one user exists)
- `GET /api/auth/me` — current user + memberships + active_tenant_id
- `GET /api/tenants`, `POST /api/tenants/switch`
- `GET /api/tenants/:id/members`, `DELETE /api/tenants/:id/members/:userId`
- `GET/POST /api/tenants/:id/invitations`,
  `DELETE /api/tenants/:id/invitations/:invId`
- `GET /api/invitations/:token` (public),
  `POST /api/invitations/:token/accept` (public — mints session)
- `GET/POST/PATCH/DELETE /api/auth-provider-configs` (owner only)

### Added — web UI

- **LoginPage** — email + password fields, SSO buttons for every
  enabled OIDC provider.
- **SetupPage** — email + display name + password for the owner of
  the brand-new instance.
- **`/invite/:token`** — public landing for invitation links;
  collects email + name + password, accepts the invite, mints the
  session, lands on the dashboard.
- **`/workspace`** — new admin page with three sections:
  - **Members** — roster + role pill + Remove (owner only).
  - **Invitations** — list pending + create form + Copy-link +
    Revoke. The accept URL is `https://<host>/invite/<token>`.
  - **Auth providers** — list configured OIDC/SAML providers; form to
    add a preset (Google/Microsoft/GitHub) or a Generic OIDC config
    with discovery URL + client id + client secret + redirect URI.
    `client_secret` is masked on the list view. SAML rows surface but
    can't be enabled until the SAML implementation lands.

### Migration notes

- `npm run migrate --prefix server` applies 017 + 018.
- Existing single-user installs: the migration backfills your user as
  owner of the seeded Default tenant. Your password keeps working. You
  may want to set an email via the UI (`/workspace`) once it's live.
- Existing data rows now carry `tenant_id = <Default>`. RLS isn't
  active yet — every authenticated request can still see all data in
  the instance. The data isolation guarantee arrives in the follow-up
  migration that turns on RLS and updates every query.

### Tests

- `+8` integration tests (`multi-tenant.test.ts`): providers listed,
  tenants list, me-returns-memberships, invitation create+accept,
  double-accept rejected, member-remove, provider-config CRUD,
  duplicate-slug 409.
- The seeded test user now carries a Default-tenant membership +
  email + identity row so existing private-route tests pass
  unchanged.
- **Total: 359** (server 353 + web 6).

### Deferred (next slices)

- **RLS enforcement** — turn on Postgres Row Level Security on every
  data table with `current_setting('app.tenant_id')` predicates, and a
  request hook that `SET LOCAL`s the active tenant. Until this lands,
  app-layer scoping is the only thing keeping tenants apart, which is
  fine for households sharing an instance but not for SaaS isolation.
- **SAML 2.0** — actual SP-initiated flow with XML-signature verification
  via a vetted library (`@node-saml/node-saml` or similar).
- **Self-serve tenant creation + tenant switcher in the top bar** —
  today every user lives inside the seeded Default tenant. The UI
  doesn't expose multi-tenant switching because the data model
  doesn't enforce it yet.

---

## [0.7.9] — 2026-05-23 — Fuzzy filters, column show/hide rollout, heap fix, configurable refresh

Three knobs the user asked for, plus a real bug fix that was making the
Health page's Heap gauge alarmist.

### Fixed

- **Heap gauge denominator** — the gauge was reading
  `heap_used / heap_total * 100`. V8 grows `heap_total` only on demand,
  so that ratio sits at 70–90% in steady-state regardless of actual
  headroom, which made the gauge look critical when it wasn't. The
  server now exposes `heap_size_limit_bytes` (V8's hard ceiling, from
  `v8.getHeapStatistics()`), and the Heap gauge uses that as the
  denominator. Typical values drop into single digits, and a number
  approaching 80% genuinely means OOM is near.

### Added

- **Configurable refresh interval on `/health`** — header dropdown
  with 1s / 5s / 10s / 30s / 60s / Off. Choice persists to localStorage
  (`health:refresh_ms`) so reloading the page keeps your cadence.
  Replaces the Pause button (Off serves that role now).
- **Fuzzy-search mode in `FilterableTable`** — the per-column string
  filter now also accepts subsequence matches: typing `gth` finds
  "Groceries Total Health" (substring still works first). A new
  **global filter** input in the toolbar searches every visible cell
  with subsequence semantics — the closest thing to "fuzzy as you
  type" in the spirit of a command palette. Numeric/date operator
  syntax (`>100`, `2026-01..2026-06`) is unchanged.
- **`FilterableTable` rowActions slot** — table accepts a per-row
  React fragment renderer so pages with per-row buttons (Bills,
  Subscriptions, Backups) keep their existing actions while gaining
  filters + column show/hide.
- **Filter / column show-hide rolled out**:
  - `BillsPage` — both tables (bills + recurring income).
  - `SubscriptionsPage` — active subscriptions table.
  - `BackupsPage` — history table.
  - `ReportsPage` already had it (since 0.7.7).
  - `TransactionTable` is unchanged in this slice; its inline
    category dropdown + selection + attachment/split actions don't
    slot into `FilterableTable` cleanly, and the page already has a
    server-side search. A targeted column chooser is queued.

### Tests

- The health snapshot test now asserts `heap_size_limit_bytes >
  heap_used_bytes` so a regression to the old denominator is caught.
- **Total: 351** (server 345 + web 6).

---

## [0.7.8] — 2026-05-23 — Live gauges + line charts on the Health page

Operator metrics the way a systems engineer wants them: a rolling-buffer
sampler runs in-process every 5 seconds, capturing CPU, memory, event-
loop delay, request rate, error rate, and DB query rate + latency. The
Health page renders the current values as colored gauges and the last 5
minutes as Recharts line charts.

### Added

- **`MetricsRecorder` singleton** (`domain/metrics-recorder.ts`) —
  rolling buffer of 720 samples (1 hour at 5s resolution). Each
  sample captures:
  - `cpu_pct` — process CPU % over the window (from `process.cpuUsage()`
    deltas; can exceed 100 on multi-core when busy)
  - `rss_bytes`, `heap_used_bytes`, `heap_total_bytes` — Node memory
  - `event_loop_mean_ms` and `event_loop_p99_ms` — from
    `perf_hooks.monitorEventLoopDelay()`, reset per sample
  - `event_loop_util` — 0..1, 1 = saturated
  - `req_count` / `req_rate` — HTTP responses served in the window
  - `err_count` / `err_rate` — share that returned 5xx
  - `db_query_count` / `db_query_rate` / `db_query_mean_ms` /
    `db_query_max_ms` — DB query throughput + latency
- **Request instrumentation** — `onResponse` hook on the Fastify
  instance bumps the request + error counters.
- **DB-query instrumentation** — the `query()` helper in `db/pool.ts`
  wraps every call with timing reported to the recorder. Direct
  `pool.query` calls aren't instrumented; that was a deliberate
  tradeoff after a fragile attempt to override the multi-overload
  method on the pg.Pool class itself.
- **`GET /api/health/timeseries[?window=N]`** — returns the rolling
  buffer (last N seconds or the full hour). Each point matches the
  `MetricSample` shape documented above.
- **`GET /api/health/live`** — most recent sample alone (for gauge-only
  widgets that don't need history).
- **Health page charts + gauges**:
  - **Six gauges** with color-toned arcs (green/yellow/red): CPU %,
    Heap %, event-loop p99 ms, requests/sec, DB qps, error rate %.
    Thresholds chosen from operational experience —
    CPU 70/90, heap 70/90, event-loop 50/100 ms, latency 50/200 ms,
    error rate 1%/5%.
  - **Six line charts** at the 5-minute resolution: CPU %, Memory
    (RSS + heap), Requests/sec, DB query rate + mean latency on a
    dual-axis chart, event-loop mean + p99, Errors/sec.
  - Existing static info cards (app / db / storage) move below the
    live panels.

### Tests

- `+2` integration tests (`health-backups-reports.test.ts`):
  timeseries envelope shape + per-point typing; live snapshot contract.
- **Total: 351** (server 345 + web 6).

---

## [0.7.7] — 2026-05-23 — Column filters + show/hide on report tables

Reports get two power-user knobs: hide columns you don't care about,
and filter rows by per-column expressions (`>100`, `2026-01..2026-06`,
substring). Column visibility persists per-report in localStorage so
choices survive reloads.

### Added

- **`FilterableTable` component** — reusable. Wraps a `<table>` with:
  - A **Columns** dropdown listing every column with a checkbox; the
    minimum-one-visible rule prevents the table from disappearing.
    Persisted to `localStorage['tableviz:<storageKey>']`.
  - A **Filter** toggle that reveals a per-column text input below
    the header. Syntax:
    - **string**: case-insensitive substring (`groceries`).
    - **cents**: dollars-typed operators (`>100`, `<50`, `100..500`).
    - **number / pct**: same operators on raw numbers.
    - **date**: `>2026-01-01`, `2026-01..2026-06`, or substring.
  - An active-filter count badge + Clear-all-filters link.
  - Emits the filtered + visible-projected dataset upward so CSV
    export honors the current view.
- **Reports page** swaps its inline table for `FilterableTable`. CSV
  export now respects the visible/filtered projection — the button's
  tooltip flips between "exports the full result" and "exports only
  the filtered + visible columns" so the user knows what they'll get.

### Notes

- The component is decoupled from reports. Other table-heavy pages
  (Transactions, Bills, Subscriptions) can adopt it later by passing
  their own `{key,label,type}` column array and a `formatCell` fn.

---

## [0.7.6] — 2026-05-23 — Health, backups, reports

Three operator-facing tools land together: a live health dashboard, a
GUI-managed backup pipeline with a schedule, and a canned-reports
catalog (the foundation for the AI natural-language reports planned
for a later slice).

### Added

- **Migration 016** — new `backups` table tracking every snapshot
  (kind, status, size, on-disk path, optional error).
- **`/health` page** — auto-refreshing dashboard with three cards:
  - **Application** — version, Node, uptime, PID, RSS / heap, AI
    provider + model.
  - **Database** — connection ok/down, ping latency, db size, pool
    counts (total/idle/waiting), last applied migration, per-table
    row counts (accounts, transactions, categories, bills, budgets,
    goals, attachments, backups).
  - **Storage** — attachments dir + backups dir size and file count,
    plus the resolved on-disk paths.
  - `GET /api/health/metrics` returns the JSON snapshot. Polls every
    5s; Pause / Refresh buttons in the header.
- **`/backups` page** — schedule editor + manual-run button + history.
  - Schedule form writes `BACKUP_ENABLED`, `BACKUP_FREQUENCY` (hourly
    / daily / weekly / monthly), `BACKUP_TIME` (HH:MM), `BACKUP_RETENTION_DAYS`,
    and `BACKUP_DIR` into `app_settings`. Live — the in-process
    scheduler picks up changes on its next tick.
  - **Run backup now** triggers a synchronous snapshot via the same
    pg_dump+tar pipeline as `scripts/backup.mjs` (custom-format dump
    of the database, gzipped tar of the attachments directory) into
    a timestamped folder. Restorable with `scripts/restore.mjs` or
    `pg_restore` directly.
  - **Prune old** removes anything past the retention window.
  - History table shows kind, status, sizes, path, and a per-row
    delete button.
- **`/reports` page** — sidebar list + parameter form + result table
  + CSV export. Initial canned set (6 reports):
  - **Spending by category** (date range)
  - **Top merchants by spend** (date range + top-N)
  - **Monthly income vs expense** (months back)
  - **Active subscriptions roll-up** (per-cycle + annualized)
  - **Largest transactions** (date range + top-N)
  - **Net worth by month** (months back)
  - `GET /api/reports` lists definitions, `POST /api/reports/:id/run`
    executes one with body-keyed parameters.
- **In-process backup scheduler** — ticks every 60 s; reads
  `BACKUP_*` settings every tick, so a config change takes effect on
  the next minute without a restart. Last-run gate uses
  `MAX(backups.finished_at)` so a process restart never re-fires a
  backup that already ran today.

### Tests

- `+12` integration tests (`health-backups-reports.test.ts`):
  health snapshot shape + table counts, backups config GET/PUT,
  history filter (deleted excluded), delete idempotency + 400 path,
  6 reports listed, spending-by-category with date filter,
  subscription-costs annualization.
- **Total: 349** (server 343 + web 6).

### Notes

- Backups need `pg_dump` on PATH. The runtime Docker image already
  bundles `postgresql17-client`, so the container is good to go.
- Restore is a manual step — `scripts/restore.mjs <path>` or
  `pg_restore` against `db.dump`. A GUI restore is on the docket but
  intentionally not in this slice (too destructive without dry-run +
  confirmation flow design).

---

## [0.7.5] — 2026-05-23 — AI subscription scan

A "Find with AI" button on the Subscriptions page surfaces candidate
subscriptions discovered in the transaction history. The rules-based
recurring detector finds the candidates; Claude (when configured) then
filters them down to actual cancelable/alterable services and cleans
up their display names.

### Added

- **`POST /api/subscriptions/scan`** — runs the rules-based detector
  on the transaction history, inserts new bill-kind candidates into
  `recurring_suggestions` (skipping any already on file), and — when
  `AI_PROVIDER=claude` — asks Claude to classify each pending
  unrefined candidate as subscription / non-subscription. Subscriptions
  get a polished `display_name` and `ai_refined=true`. Non-subscriptions
  (utilities, rent, loans, insurance) get auto-rejected so they don't
  clutter the queue. Returns `{ai_used, scanned, inserted, kept,
  rejected}`.
- **`GET /api/subscriptions/candidates`** — pending bill-kind
  suggestions, ordered AI-refined first, then by confidence.
- **`domain/subscription-ai.ts`** — Claude classifier. Single
  Anthropic-SDK call per scan (batched, prompt-cached), Haiku-tier
  model by default. Falls back to the rules-only path when
  `AI_PROVIDER` isn't `claude` (Ollama support is not wired today).
- **Subscriptions page UI** — new **Find with AI** button in the page
  header. A "Candidates" section appears above the action queue,
  showing each pending candidate as a card with Confirm / Snooze /
  Not-a-subscription buttons. Confirm reuses the existing
  `/api/recurring/suggestions/:id/confirm` flow, so the new bill
  immediately shows up in the active list below.

### Tests

- `+4` integration tests (`subscriptions-scan.test.ts`): rules-only
  fallback ignores income-kind, candidates GET filters out income +
  rejected, scan idempotency.
- **Total: 336** (server 330 + web 6).

### Notes

- The AI step is opt-in — without `AI_PROVIDER=claude` the scan still
  works as a one-click rules-based detector limited to bill-kind
  outflows. Cost per scan with Haiku is ~$0.001–0.01.

---

## [0.7.4] — 2026-05-23 — Uncategorized hub + subscription action queue

Two adjacent gaps closed: a dedicated landing pad for transactions that
don't yet have a category (with bulk fix-ups), and a review queue for
recurring bills so the user can flag the ones they're not actively
using and pick an action — cancel, downgrade ("alter"), or keep with a
note.

### Added

- **`/uncategorized` page** — lists every transaction where
  `category_id IS NULL` AND no splits exist. The inline category
  dropdown lives on each row; once a row is categorized (or
  bulk-edited) it disappears from the list.
- **`uncategorized=true` query param** on `GET /api/transactions`,
  reused by the new page. Split-only transactions count as
  categorized.
- **Bulk-delete transactions** via `POST /api/transactions/bulk-delete`
  + a destructive **Delete** button on the BulkActionBar (gated behind
  a confirm). FK cascade handles splits and attachments cleanly.
- **`bills.review_status` workflow** (migration 015). Statuses:
  `active` (default), `review`, `cancel`, `alter`, `keep`. Bills also
  gain `review_note` (free text) and `last_reviewed_at`.
- **`PATCH /api/bills/:id/review`** — set the status, optionally
  attach a note (pass `note: null` to clear). Every change bumps
  `last_reviewed_at`.
- **`GET /api/bills?reviewStatus=…`** filter. The special
  `reviewStatus=queue` returns the user's action queue (status in
  `review`/`cancel`/`alter`, ordered by most-recent review).
- **`/subscriptions` page** — top section is the action queue, bottom
  section is the active list with a per-cycle and approximate monthly
  cost (cross-cadence comparison). Each queued card has Cancel /
  Alter / Keep buttons, a free-text note ("Downgrade to ad-tier"), and
  a Clear-flag link.

### Tests

- `+9` integration tests (`uncategorized-and-subscriptions.test.ts`):
  uncategorized filter (3), bulk delete (2), review-status PATCH +
  queue filter (4).
- **Total: 332** (server 326 + web 6).

---

## [0.7.3] — 2026-05-23 — Commute routes, Misc + Savings, AI model picker

Routes replace the old standalone toll list with a richer model: each
route has a distance and an optional per-crossing toll, and every
vehicle says how many times per week it takes that route. Fuel and
toll math now both flow from the same source. The budget wizard gains
two more editable rows (Misc with a memo, Savings with four suggestion
chips), and the Settings page picks AI models from a provider-aware
dropdown with token/cost hints.

### Added

- **`commute_routes` + `route_vehicle_assignments`** (migration 014).
  A route has a name, distance, an optional toll/crossing, and N
  vehicle assignments saying how many times that vehicle takes it per
  week. The legacy `toll_routes` table is dropped after a one-shot
  migration of existing rows (distance=0, toll = the old
  weekly_estimate).
- **`/routes` page** — replaces `/tolls`. Per-route card shows
  distance, toll/crossing, total weekly crossings, computed weekly
  toll. Inline edit of assignments (toggle a vehicle, set its
  crossings/week).
- **Route-driven fuel + toll math** in the wizard. For each active
  vehicle, derived weekly miles = SUM(route.distance ×
  this-vehicle's crossings). Vehicles with no route assignments fall
  back to the stored `weekly_avg_miles`. Tolls = SUM(route.toll ×
  total crossings) across active routes.
- **Misc editable** in the wizard — a 4th row per period for
  known-coming one-offs (oil change, birthday gift). Each Misc entry
  has its own amount AND a memo, stored via the new `budgets.note`
  column. Commit creates one row per period under the new
  "Miscellaneous" category.
- **Savings editable + 4 suggestion chips** — per-period preview shows
  four numbers: **Goal-required** (from active `savings_goals` with
  target_date; required-per-period = (target − current) /
  periods-to-target), **% of income**, **% of leftover**, and the
  **max**. Click a chip to populate the editable Savings amount.
  Commit creates a Savings budget row per period when > 0.
  Configurable via two new settings: `SAVINGS_INCOME_PCT` (default
  20) and `SAVINGS_LEFTOVER_PCT` (default 50).
- **AI model picker** — new `GET /api/settings/ai-models?provider=X`.
  Claude returns a hardcoded list with per-model cost hints
  (`claude-haiku-4-5` recommended for SmrtCash, sonnet for edge cases,
  opus marked overkill). Ollama queries the configured base URL's
  `/api/tags` and falls back to a curated list when unreachable. The
  Settings page model field renders a dropdown with the recommended
  model starred + a "Custom" escape hatch.
- **EIA "create key" link** under the EIA_API_KEY field →
  `https://www.eia.gov/opendata/register.php`.
- **"Miscellaneous" and "Savings" leaf categories** seeded into the
  default taxonomy.

### Changed

- The old `/api/toll-routes` endpoints and the `tollRoutes`
  client-side functions are gone — `commuteRouteRoutes` replaces them.
- The wizard's `flexCents` formula now subtracts Misc and Savings too.

### Tests

- **+13 server tests** (304 → 317): commute-routes CRUD (5),
  route-driven wizard math + Misc/Savings flow (6), AI models endpoint
  (3). Existing wizard test updated to use commute_routes instead of
  toll_routes for the toll-sum assertion. Total automated coverage:
  **330 tests** (server 317 + web 6 + Playwright 7).

### Migration notes

- **Upgrading from 0.7.2:** `npm run migrate --prefix server` applies
  migration 014 (drops `toll_routes`, adds `commute_routes` +
  `route_vehicle_assignments` + `budgets.note` + seeds the two new
  categories).
- Existing toll-route entries migrate to commute_routes with
  distance=0. You'll want to revisit them to set the real distance and
  add vehicle assignments — otherwise their tolls won't fire (no
  crossings × any non-null toll = 0).

---

## [0.7.2] — 2026-05-23 — Settings page (GUI-managed runtime config)

Stop SSHing into the box to edit `.env` and bounce the container. Every
runtime-tweakable config value now has a GUI control on the new
**Settings** page; the dangerous ones (session secret, attachment
encryption key) are gated behind type-to-confirm dialogs.

### Added

- **`app_settings` table** (migration 013). One row per `(key, value)`
  override. A non-null DB value wins over `process.env` at read time;
  clearing the row falls back to env. Plain-text storage — same trust
  boundary as `.env` on the same host.
- **`domain/settings.ts`** — list of `KNOWN_SETTINGS`, each with
  `is_secret` + `restart_required` metadata. `applyBootSettings()`
  loads DB overrides into the in-memory `config` object before
  Fastify registers the cookie plugin / parses the attachment key.
  `applyToConfig()` hot-mutates the same object on live updates so the
  next AI / fuel-price call sees the new value.
- **Settings API**:
  - `GET /api/settings` — every known setting with masked secret
    values (`••••XXXX`, last 4 chars only), plus
    `configured_in_gui` / `env_fallback_present` flags so the UI
    can show provenance.
  - `PUT /api/settings/:key` — value goes in clear, comes back
    masked. Per-key validation (provider allow-list, encryption-key
    shape, session secret length). Response carries
    `restart_required: true` for `SESSION_SECRET` and
    `ATTACHMENT_ENCRYPTION_KEY`.
  - `DELETE /api/settings/:key` — clears the override, re-reads env
    into in-memory config.
- **`POST /api/admin/restart`** — flushes the response, then
  `process.exit(0)`. Docker's `restart: unless-stopped` brings the
  container back up; in dev the operator restarts the process.
- **`/settings` page** — three cards:
  - **AI Provider** — provider dropdown, Anthropic key/model,
    Ollama base URL/model.
  - **External APIs** — EIA API key.
  - **Security — restart required** — SESSION_SECRET
    (`type 'rotate' to confirm`) and ATTACHMENT_ENCRYPTION_KEY
    (`type 'DESTROY EXISTING' to confirm`).
  When a restart-required save lands, a banner + a top-right
  **Restart server** button appear. The button POSTs to
  `/api/admin/restart` and refreshes the page after 2 seconds.

### Changed

- **Boot order** — `buildApp()` calls `applyBootSettings()` before
  registering `@fastify/cookie` so a GUI-set `SESSION_SECRET` wins over
  `.env` at startup. Same for the attachment encryption key.

### Tests

- **+11 server tests** (293 → 304): list, masking, non-secret
  passthrough, AI_PROVIDER allow-list, hot mutation,
  restart_required surfaces correctly, unknown-key rejection,
  empty-value rejection, SESSION_SECRET length validation,
  ATTACHMENT_ENCRYPTION_KEY shape validation (hex + base64 +
  invalid), DELETE-reverts-to-env.
- Total automated coverage: **317 tests** (server 304 + web 6 +
  Playwright 7).

### Migration notes

- **Upgrading from 0.7.1:** `npm run migrate --prefix server` applies
  migration 013 (just the `app_settings` table).
- Your existing `.env` continues to work — DB rows are additive
  overrides. You can ignore the Settings page if you prefer the
  `.env` workflow.
- The restart endpoint requires a supervisor (`docker compose` does
  this by default). Without one, calling it stops the server until
  you restart it manually.

---

## [0.7.1] — 2026-05-22 — Phase 7.1: AutoMagic budget wizard + vehicles + toll routes

A coherent "set up the next N budget periods in one click" flow. The
wizard projects existing bills + income into each future period and
pre-fills three editable categories (Groceries, Fuel, Tolls) using
historical data, fleet info, and active toll routes. Commit writes
real budget rows, including one per individual bill instance.

### Added

- **Vehicles** (`/vehicles` page, `/api/vehicles` CRUD). Each vehicle
  records `fuel_type` (regular/midgrade/premium/diesel/electric),
  `weekly_avg_miles`, and either `mpg` (ICE) or `kwh_per_mile` +
  `electricity_rate_cents_per_kwh` (EV). A DB CHECK keeps the
  type-specific fields coherent.
- **Toll routes** (`/tolls`, `/api/toll-routes`). Named recurring toll
  outlays, each with a weekly $ estimate and active flag. The wizard
  sums every active route into one Tolls number per period.
- **Fuel prices** (`/api/fuel-prices`):
  - Cached per grade in `fuel_prices`, source `eia` or `manual`.
  - `POST /api/fuel-prices/refresh` pulls latest weekly US averages
    from `api.eia.gov` when `EIA_API_KEY` is configured. Manual
    overrides are preserved (the user's choice wins).
  - The Vehicles page surfaces the current values with inline
    "Set manual" fields + a "Refresh from EIA" button.
- **AutoMagic budget wizard** (`/api/budgets/wizard/preview` and
  `/commit`). Inputs: period type, anchor date, count (1–24). For each
  future period the preview computes:
  - Income instances (from `recurring_income`, projected by frequency)
  - Bill instances (from `bills`, projected; one row per instance)
  - Groceries default = median of last 8 weeks of Groceries-category
    spend, scaled to the period length
  - Fuel = `Σ vehicles (weekly_miles / mpg × $/gal)` for ICE +
    `Σ EVs (weekly_miles × kWh/mi × $/kWh)`, scaled
  - Tolls = sum of active toll routes' weekly estimates, scaled
  - Implicit flex = income − bills − the three (shown, not stored)
- **Per-period inline editing.** Groceries / Fuel / Tolls each have an
  amount input per period — overrides flow back into the preview math.
- **Commit semantics.** Writes per-period budget rows for the three
  editable categories *plus* one bill-linked budget row per bill
  instance falling in that period. `budgets.bill_id` (new column,
  migration 012) links the row to its source bill. Existing rows are
  never overwritten — skip-duplicates is the rule; the response reports
  created/skipped counts.
- **Bill-linked budget actuals.** `/api/budgets/actual` now includes
  `bill_id`, `bill_name`, and `bill_next_due_date`. For bill-linked
  rows, `actual_cents` flips to the budgeted amount the moment the
  bill is marked paid (its `next_due_date` advances past the row's
  period end); otherwise 0.

### Changed

- `BUDGET_COLUMNS` extended and every `/api/budgets` query joins
  `bills` so the response carries bill-linked metadata.
- Sidebar adds **Vehicles** and **Tolls** entries.
- `EIA_API_KEY` env var documented in `.env.example` (added below).

### Tests

- **+6 server tests** (287 → 293) covering the wizard preview math
  (groceries median, fuel math from vehicles + price cache, toll route
  sum) plus the commit path (creates 3 editable rows + 1 per bill,
  skip-duplicates on re-run).
- Total automated coverage: **306 tests** (server 293 + web 6 +
  Playwright 7).

### Migration notes

- **Upgrading from 0.7.0:** `npm run migrate --prefix server` applies
  migration 012 (vehicles + toll_routes + fuel_prices tables +
  `budgets.bill_id`).
- Set `EIA_API_KEY` in `.env` (free key from
  https://www.eia.gov/opendata/register.php) to enable auto-refresh of
  fuel prices. Without it, manual entry covers the same use case.

---

## [0.7.0] — 2026-05-22 — Phase 7.0: Investment holdings + manual assets & liabilities

Phase 7 is being released in three slices. **7.0 lands the wealth-
tracking core** — investments with cost basis and mark-to-market, plus
manual asset/liability accounts for things SmrtCash can't see (houses,
cars, mortgages, loans). The dashboard's net-worth chart now reflects
your complete picture, not just the bank-import slice. **7.1**
(multi-currency) and **7.2** (retirement projections) follow.

### Added

- **Investment holdings.** New `holdings` table (migration 011) with
  `(account_id, symbol, name, quantity NUMERIC(18,6), cost_basis_cents,
  last_price_cents, last_price_date)`. Six decimals on `quantity`
  supports fractional shares and crypto. Holdings are entered manually
  in 0.7.0; auto-price-fetching is a future hook.
- **Holdings CRUD** at `/api/holdings` (`GET ?accountId=`, `POST`,
  `PATCH`, `DELETE`). `POST` enforces that the parent account is of
  type `investment`. List responses include the derived
  `market_value_cents` (`quantity × last_price_cents`) and
  `unrealized_gain_cents` (market value − cost basis).
- **Investment account balance** now equals `opening_balance_cents +
  sum(transactions on/after opening date) + sum(holdings market value)`.
  A new `holdings_value_cents` field is exposed separately so the UI
  can split "cash side" from "equity side" if desired.
- **Manual asset / liability accounts.** Two new account types —
  `manual_asset` (house, vehicle, art) and `manual_liability`
  (mortgage, auto loan, student loan). These accounts have no
  transactions; their value lives in `opening_balance_cents` and the
  user adjusts it periodically.
  - **Convention:** liabilities are stored as **negative** balances so
    a single `SUM()` across all accounts yields net worth. The web form
    accepts "Amount owed" as a positive number and negates on save.
- **Holdings panel** on the Account Detail page (investment accounts
  only). Per-row **Update price** (mark-to-market) and **Delete**, plus
  totals: market value, cost basis, unrealized gain.
- **Account form** learns the two new types; the opening-balance form
  on the detail page changes its label and copy for manual A&L
  ("Amount owed" for liabilities, "Current value" for assets).
- **Net worth over time** at `/api/insights/net-worth-over-time` now
  includes holdings (`quantity × last_price`) and manual A&L
  (`opening_balance_cents`) alongside cash accounts. The dashboard
  chart picks up the wider view automatically.

### Tests

- **+7 server tests** (280 → 287): holdings CRUD happy path,
  non-investment-account rejection, mark-to-market, quantity > 0,
  investment-balance = cash + market-value, manual A&L creation,
  net-worth-over-time math with the full mix.
- Total automated coverage: **300 tests** (server 287 + web 6 +
  Playwright 7).

### Migration notes

- **Upgrading from 0.6.2:** `npm run migrate --prefix server` applies
  migration 011 (holdings table + expanded account-type CHECK).
- No backfill needed — existing accounts keep their balance math; only
  new investment accounts pick up the holdings-aware total.

### What's still coming in Phase 7

- **0.7.1 — multi-currency.** Each account already has a `currency`
  column; the queries will gain conversion to a configurable base
  currency, with an `exchange_rates` table.
- **0.7.2 — retirement projections.** Compound-growth math against
  contributions and an assumed return, surfaced as a scenarios page.

---

## [0.6.2] — 2026-05-22 — Phase 6.2: Bulk edits, transaction splits, learned normalization rules

Three intertwined features that together make manual cleanup massively
faster: edit dozens of transactions at once, turn each edit into a rule
the system applies forever, and break a single transaction into
per-category slices (a $100 Costco run that's $60 groceries + $40
clothing now shows up correctly on the dashboard).

### Added

- **Bulk transaction edits.** New `PATCH /api/transactions/bulk` accepts
  an `ids` array plus `updates: { categoryId?, merchant? }` and applies
  uniformly. Touched rows flip to `normalization_status='manual'`.
  Driven from a new **bulk-action toolbar** that appears on
  `/transactions` whenever rows are selected via the new per-row
  checkboxes (and the "select all on page" header checkbox).
- **Learned normalization rules.** `normalization_rules` table
  (migration 009): `(pattern, normalized_merchant, category_id)` with a
  case-insensitive unique index. The bulk toolbar offers a
  **"Save as rule"** checkbox so a one-time bulk rename can be captured
  as a permanent rule. Endpoints:
  - `GET / POST / PATCH / DELETE /api/normalization-rules`
  - `POST /api/normalization-rules/preview { pattern }` — counts matches
    without writing (used by the future "Apply to similar?" UI).
  - `POST /api/normalization-rules/apply { ruleIds?, includeManual? }`
    — runs every rule over non-manual transactions; rows touched flip
    to `normalization_status='normalized'`. Manual edits stay manual
    unless `includeManual: true`.
- **Transaction splits.** New `transaction_splits` table — one row per
  category slice. `PUT /api/transactions/:id/splits` replaces all
  splits in a single call, enforcing `sum(amount_cents) =
  transaction.amount_cents`. Empty array clears splits entirely.
  Surfaced via a **✂ Split** action on every transaction row that
  opens a modal: add lines `(category, amount, memo)`, the running
  total + remaining shows live, save is disabled until it balances.
- **`transaction_category_lines` view** (migration 010) — single source
  of truth that expands split transactions into per-category lines.
  Used by `/api/insights/spending-by-category` and
  `/api/budgets/actual` so split transactions now contribute their
  per-category slice instead of dumping into the transaction-level
  category. Transactions without splits still report under their own
  `category_id`.
- **Bulk recurring suggestion actions.** `POST /api/recurring/suggestions/bulk`
  with `action: 'confirm' | 'reject' | 'snooze'`. The Suggestions panel
  gets a "Select all" checkbox + per-row checkboxes + an action bar
  with **Confirm selected** / **Snooze selected** / **Reject selected**.
  Confirm uses each suggestion's detector defaults (name + cadence);
  for fine-tuning use the single-suggestion confirm modal.

### Changed

- `TransactionTable` learned a `selection` prop and an `onOpenSplits`
  callback. Existing callers (AccountDetailPage) keep their previous
  behavior — selection is only rendered on the Transactions page.

### Tests

- **+14 server tests** (266 → 280): bulk PATCH happy paths +
  validation, rule preview / apply / manual-skip / includeManual /
  duplicate-pattern / no-op-refusal, splits sum-mismatch +
  empty-clears + insights-respect-splits, bulk recurring reject +
  confirm-with-samples.
- Total automated coverage: **293 tests** (server 280 + web 6 +
  Playwright 7).

### Deferred (per the original ask)

- **Receipt-line auto-split** — extending OCR to return line items +
  proposed categories. Worth a dedicated phase because the prompt and
  UX surface (let user accept / edit the proposed split) are
  meaningful in their own right.

### Migration notes

- **Upgrading from 0.6.1:** `npm run migrate --prefix server` applies
  migrations 009 (rules + splits tables) and 010 (the view).

---

## [0.6.1] — 2026-05-22 — Phase 6.1: Recurring detection + flexible budget periods

Completes the deferral noted in the 0.6.0 changelog. **Auto-detect
recurring bills and income, then verify each with a single click**, plus
budgets now support weekly / biweekly / semi-monthly / monthly /
custom-range cadences.

### Added

- **Recurring detection (`POST /api/recurring/detect`).** Rules-based
  pass that buckets transactions by (normalized merchant, sign), finds
  groups of ≥ 3 occurrences, measures the mean interval and variance,
  and classifies the cadence (`weekly` / `biweekly` / `semimonthly` /
  `monthly` / `yearly` / `unknown`). Confidence is a 0..1 score
  combining cadence-fit, variance-tightness, and sample count. Amount
  is the median of the group, so a single outlier doesn't skew the
  suggestion. Transfers between own accounts are excluded.
- **`recurring_suggestions` table** (migration 007) — pending /
  confirmed / rejected / snoozed. A unique partial index on
  `(kind, lower(normalized_key))` for non-rejected rows means re-running
  the detector doesn't spam duplicates; rejected entries stay rejected
  so already-dismissed patterns never come back.
- **Verification flow** — new "Suggested recurring items" panel on
  `/bills` lists every pending suggestion with name, amount,
  detected cadence, and confidence. Three actions:
  - **Confirm** opens a modal pre-filled with the detector's guess; you
    can override the name and the frequency, then click **Confirm** to
    create the matching `bill` or `recurring_income` row.
  - **Snooze** — keeps the suggestion eligible for confirmation later
    but hides it from the pending list.
  - **Not recurring** — rejects it; the key is remembered so the
    detector won't surface it again.
- **Flexible budget periods.** `budgets.period_type` and
  `budgets.period_end` (migration 007) — five cadences:
  `weekly` / `biweekly` / `semimonthly` / `monthly` / `custom`. The
  add-budget form lets you pick one; the `/budgets` page renders a
  pill on each row showing its cadence and the active
  start → end range.
- **`/api/budgets/actual?asOf=YYYY-MM-DD`** — for any given date,
  returns every budget with its current rolling [start, end) window and
  the actual spending against it. The legacy `?month=` form still
  works and now only matches monthly budgets.
- **`PATCH /api/budgets/:id`** — edit the amount without deleting and
  recreating.

### Changed

- The monthly upsert path on `POST /api/budgets` now returns **200** on
  update (was 201). Insertion still returns 201.
- `budgets.period_month` no longer requires day=1 — migration 008
  drops the original CHECK so any anchor date is accepted, which the
  non-monthly cadences need.

### Fixed

- **Dockerfile healthcheck.** `wget` wasn't in `node:22-alpine`, so the
  `app` container always showed `unhealthy`. Added `wget` to the apk
  install line.

### Tests

- **+16 server tests** (250 → 266):
  - 9 unit tests for the detector (monthly / biweekly / weekly cadences,
    erratic spacing classified as `unknown`, median amount, sign
    separation, < 3 occurrences ignored, raw-description fallback,
    confidence ordering).
  - 7 integration tests for the API (detect + list, dedup on re-run,
    confirm-creates-bill, confirm-creates-income, reject prevents
    re-detection, snooze keeps confirmable, transfers excluded).
  - Existing budgets tests updated for the new upsert status code +
    relaxed anchor-date validation.
- Total automated coverage: **279 tests** (server 266 + web 6 +
  Playwright 7).

### Migration notes

- **Upgrading from 0.6.0:** `npm run migrate --prefix server` applies
  migrations 007 (`recurring_suggestions` + budget period columns) and
  008 (drops the day-of-month CHECK on `budgets.period_month`).
- The detector is **on-demand only** — there's a "Detect recurring"
  button on `/bills`. It does not run automatically on imports.

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
