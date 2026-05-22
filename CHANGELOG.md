# Changelog

All notable changes to SmrtCash are documented here.

This project adheres to [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## [Unreleased]

_Phase 3 work will land here._

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
