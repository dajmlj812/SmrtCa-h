# SmrtCash — General Documentation

Technical reference for the SmrtCash application.

- New here? Start with the [Quick Start](./QUICKSTART.md).
- Want to know what it does? See the [Feature List](./FEATURES.md).

> SmrtCash is a hosted SaaS operated by BuildITSmrt, LLC. The
> architecture notes below describe how the service is built; they are
> not setup instructions (there's nothing for you to install — just
> sign up at [smrtcash.builditsmrt.com](https://smrtcash.builditsmrt.com)).

---

## 1. Overview

SmrtCash is a hosted personal finance manager. You connect a bank or import
statement exports; SmrtCash stores them, de-duplicates them, and uses AI to
clean and categorize each transaction.

**Design principles**

- **Your data, isolated and encrypted.** Each household's data is isolated
  per tenant in our managed PostgreSQL, encrypted at rest, and exportable in
  full at any time. Transaction text is only sent to an AI provider when you
  use AI features.
- **Exact money.** All amounts are stored as integer **cents**. Floating-point
  math is never used for currency.
- **Typed end to end.** TypeScript on both the server and the client.

---

## 2. Architecture

```
   Browser
      │  http://localhost:5173
      ▼
┌──────────────┐   /api/* proxied   ┌──────────────┐   SQL   ┌──────────────┐
│  Web (Vite)  │ ─────────────────▶ │  API         │ ──────▶ │ PostgreSQL   │
│  React SPA   │                    │  (Fastify)   │         │  (Docker)    │
│  :5173       │ ◀───────────────── │  :4000       │ ◀────── │  :5432       │
└──────────────┘     JSON           └──────────────┘         └──────────────┘
```

- **Web** — a React single-page app served by Vite. In development, Vite
  proxies every `/api/*` request to the API, so the browser sees one origin.
- **API** — a Fastify server exposing a JSON REST API. Holds all business
  logic: importing, parsing, de-duplication, persistence.
- **Database** — PostgreSQL 17, run as a Docker container with a named volume
  for durable storage.

The three pieces run separately in development. Phase 5 packages all of them
into one `docker compose up`.

---

## 3. Technology stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js 24 | ES modules throughout |
| Language | TypeScript 5/6 | `strict` mode, on server and client |
| API framework | Fastify 5 | Routing, logging, multipart uploads |
| Database | PostgreSQL 17 | Runs in Docker |
| DB driver | `pg` (node-postgres) | Raw SQL, parameterized queries |
| CSV parsing | `csv-parse` | Quoted-field aware |
| XLSX parsing | `exceljs` | See [KI-02](./KNOWN_ISSUES.md) |
| Frontend | React 19 | |
| Build tool | Vite | Dev server + production bundling |
| Routing (web) | `react-router-dom` 7 | |
| Dev runner | `tsx` | Runs/watches TypeScript directly |

---

## 4. Repository layout

```
SmrtCash/
├─ docker-compose.yml      PostgreSQL service
├─ .env                    Local config + secrets (gitignored)
├─ .env.example            Config template (committed)
├─ README.md
├─ docs/                   This documentation set
├─ samples/                Local test files (gitignored)
│
├─ server/                 Fastify + TypeScript API
│  └─ src/
│     ├─ index.ts          API bootstrap, error handler
│     ├─ config.ts         Loads + validates environment
│     ├─ util.ts           Shared helpers (UUID check)
│     ├─ db/
│     │  ├─ pool.ts        pg pool, type parsers, withTransaction()
│     │  ├─ migrate.ts     Migration runner
│     │  └─ migrations/    Numbered .sql files
│     ├─ domain/
│     │  ├─ money.ts       String ⇄ integer-cents
│     │  └─ dates.ts       Date string ⇒ ISO
│     ├─ import/
│     │  ├─ types.ts       Shared import types
│     │  ├─ parse.ts       CSV/XLSX file ⇒ rows
│     │  ├─ formats.ts     Format registry + detection
│     │  ├─ dedup.ts       Duplicate hashing
│     │  └─ importer.ts    Preview + commit orchestration
│     └─ routes/
│        ├─ accounts.ts
│        ├─ transactions.ts
│        └─ imports.ts
│
└─ web/                    React + Vite frontend
   └─ src/
      ├─ main.tsx          App entry
      ├─ App.tsx           Layout + routes
      ├─ api.ts            Typed API client
      ├─ format.ts         Currency/date display helpers
      ├─ styles.css
      ├─ components/
      │  └─ TransactionTable.tsx
      └─ pages/
         ├─ AccountsPage.tsx
         ├─ AccountDetailPage.tsx
         ├─ TransactionsPage.tsx
         └─ ImportPage.tsx
```

---

## 5. Data model

Defined in `server/src/db/migrations/001_init.sql`. All primary keys are
UUIDs. Money columns are `bigint` (integer cents).

### `accounts`
A bank or credit-card account.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `name` | text | Required |
| `institution` | text | e.g. "Chase" |
| `type` | text | `checking`, `savings`, `credit_card`, `cash`, `investment`, `loan`, `other` |
| `last4` | text | Last 4 digits |
| `currency` | text | Default `USD` |
| `created_at` | timestamptz | |

### `transactions`
One financial transaction. Phase 2–4 columns exist already but are unused.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `account_id` | uuid | FK → accounts (cascade delete) |
| `import_batch_id` | uuid | FK → import_batches |
| `txn_date` | date | Transaction date |
| `post_date` | date | Posting date |
| `amount_cents` | bigint | Negative = money out |
| `raw_description` | text | Cleaned-of-padding original description |
| `source_category` | text | Category from the bank, if any |
| `source_type` | text | Bank's type code (e.g. `ACH_DEBIT`) |
| `memo` | text | |
| `balance_cents` | bigint | Running balance from the export, if present |
| `normalized_merchant` | text | Phase 2 — AI merchant name |
| `category_id` | uuid | Phase 2 — FK → categories |
| `normalization_status` | text | `pending` / `normalized` / `manual` / `skipped` |
| `transfer_group_id` | uuid | Phase 4 — links transfers |
| `dedup_hash` | text | Duplicate-detection key |
| `created_at` | timestamptz | |

Unique index on `(account_id, dedup_hash)` enforces de-duplication.

### `import_batches`
One import operation, for history and auditing — `filename`, `format_id`,
`row_count`, `imported_count`, `skipped_count`, `error_count`.

### `categories`
Category taxonomy (hierarchical via `parent_id`). Populated in Phase 2.

### `attachments`
Receipts/files linked to a transaction. Schema exists; used in Phase 3.

### `schema_migrations`
Bookkeeping table — records which migration files have been applied.

---

## 6. API reference

Base path: `/api`. All responses are JSON. Errors return
`{ "error": "message" }` with an appropriate HTTP status.

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness + DB check → `{ status, time }` |

### Accounts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounts` | List accounts with `balance_cents` + `transaction_count` |
| GET | `/api/accounts/:id` | One account (404 if missing) |
| POST | `/api/accounts` | Create. Body: `{ name, type, institution?, last4?, currency? }` → 201 |
| DELETE | `/api/accounts/:id` | Delete account + its transactions → 204 |

### Transactions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/transactions` | List transactions |

Query parameters: `accountId` (uuid), `search` (description contains),
`limit` (1–500, default 100), `offset` (default 0).
Response: `{ transactions[], total, limit, offset }`.

### Imports

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/imports/formats` | List built-in import formats |
| POST | `/api/imports/preview` | Parse + detect, do **not** save |
| POST | `/api/imports/commit` | Parse + save into an account |
| GET | `/api/imports` | List past import batches |

`preview` and `commit` accept `multipart/form-data`:

- `file` — the CSV/XLSX file (required)
- `accountId` — target account (required for `commit`)
- `formatId` — force a specific format (optional; default = auto-detect)
- `mapping` — JSON column mapping for unknown formats (optional)

`preview` returns detected format, row counts, a sample of parsed
transactions, and any row errors. `commit` returns
`{ batchId, importedCount, skippedCount, errorCount, errors }`.

---

## 7. The import pipeline

A file moves through five stages (`server/src/import/`):

1. **Parse** (`parse.ts`) — CSV or XLSX bytes become `{ headers, rows }`,
   where every cell is a trimmed string.
2. **Detect format** (`formats.ts`) — the headers are matched against a
   registry of built-in formats. A format matches if every column in its
   *signature* is present.
3. **Map rows** (`importer.ts`) — each raw row is converted to a
   `ParsedTransaction`. A row that fails (e.g. an unreadable date) is
   collected as an error; the rest of the import continues.
4. **De-duplicate** (`dedup.ts`) — each transaction gets a SHA-256
   `dedup_hash` of date + amount + description, plus an occurrence counter so
   genuinely identical rows in one file are all kept.
5. **Commit** (`importer.ts`) — rows are inserted inside a single database
   transaction using `ON CONFLICT (account_id, dedup_hash) DO NOTHING`, so
   re-importing a file adds nothing new.

### Built-in formats

| Format ID | Matches |
|-----------|---------|
| `chase_credit_card` | Chase credit-card CSV export |
| `chase_bank` | Chase checking/savings CSV export |

### Custom column mapping

For any other bank, supply a `mapping` JSON object instead of a `formatId`:

```jsonc
{
  "txnDate": "Date",
  "description": "Memo",
  "amount": "Amount",          // single signed column...
  "debit": "Withdrawal",       // ...OR a debit/credit pair
  "credit": "Deposit",
  "category": "Category",
  "balance": "Balance",
  "dateOrder": "mdy"           // mdy | dmy | ymd
}
```

`txnDate` and `description` are required; everything else is optional.
Adding more *built-in* formats is just adding entries to the registry in
`formats.ts`.

---

## 8. Configuration

All configuration is environment variables, read from the repo-root `.env`
file (shared by Docker Compose and the API). Copy `.env.example` to `.env`.

| Variable | Purpose | Example |
|----------|---------|---------|
| `POSTGRES_USER` | DB user (Compose + app) | `smrtcash` |
| `POSTGRES_PASSWORD` | DB password | *(set your own)* |
| `POSTGRES_DB` | DB name | `smrtcash` |
| `POSTGRES_PORT` | Host port for Postgres | `5432` |
| `DATABASE_URL` | Connection string the API uses | `postgres://user:pw@localhost:5432/smrtcash` |
| `PORT` | API listen port | `4000` |
| `NODE_ENV` | `development` / `production` | `development` |
| `AI_PROVIDER` | Phase 2 — `none` / `claude` / `ollama` | `none` |
| `ANTHROPIC_API_KEY` | Phase 2 — Claude API key | *(empty in Phase 1)* |
| `ANTHROPIC_MODEL` | Phase 2 — Claude model id | `claude-haiku-4-5-20251001` |
| `OLLAMA_BASE_URL` | Phase 2 — local model endpoint | `http://localhost:11434` |
| `OLLAMA_MODEL` | Phase 2 — local model name | `llama3.1` |

`.env` is gitignored — never commit real credentials.

---

## 9. Development workflow

| Action | Command |
|--------|---------|
| Start PostgreSQL | `docker compose -p smrtcash up -d db` |
| Install server deps | `npm install --prefix server` |
| Install web deps | `npm install --prefix web` |
| Run migrations | `npm run migrate --prefix server` |
| Start API (watch) | `npm run dev --prefix server` |
| Start web (watch) | `npm run dev --prefix web` |
| Type-check | `npm run typecheck --prefix server` / `--prefix web` |
| Production build | `npm run build --prefix server` / `--prefix web` |

Default ports: web `5173`, API `4000`, PostgreSQL `5432`.

The web dev server proxies `/api` to the API (see `web/vite.config.ts`), so
you only ever open `http://localhost:5173`.

---

## 10. Conventions

- **Money** — always integer cents (`bigint` in the DB, `number` in code).
  Conversions live in `server/src/domain/money.ts`. Display formatting is in
  `web/src/format.ts`.
- **Dates** — stored as PostgreSQL `date`; carried as `YYYY-MM-DD` strings to
  avoid timezone drift. Parsing is in `server/src/domain/dates.ts`.
- **SQL** — always parameterized (`$1`, `$2`, …). No string concatenation of
  user input into queries.
- **Errors** — the API has one error handler (`server/src/index.ts`).
  `ImportError` maps to HTTP 400; anything else to its `statusCode` or 500.
- **Imports are atomic** — a commit runs in one DB transaction; a failure
  rolls the whole batch back.

---

*See also: [Installation](./INSTALLATION.md) · [Admin Guide](./ADMIN_GUIDE.md)
· [Known Issues](./KNOWN_ISSUES.md) · [Roadmap](./ROADMAP.md)*
