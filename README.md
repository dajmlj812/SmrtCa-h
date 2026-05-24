# SmrtCash

A self-hosted personal finance manager (in the spirit of Quicken / Monarch).
Import bank & credit-card exports, let AI normalize messy transaction
descriptions, attach receipts, and see where your money goes — all running in
your own container, with your data staying on your machine.

## Status

**Phases 1 through 9 — complete.** Original backlog also complete
(`0.13.0` → `0.13.6`); only native mobile is deferred (the PWA covers it).
**`0.14.0` → `0.14.4` — multi-tenant isolation hardening pass** verified
end-to-end by 72 dedicated cross-tenant tests.

What ships today:

- **Import & connectivity** — CSV / XLSX / OFX / QFX / QIF import with
  bank-format auto-detection and duplicate protection; **OFX Direct
  Connect** to pull transactions straight from supporting banks;
  **opt-in Plaid integration** (off by default); **scheduled background
  sync** that drives all sources on a per-source cadence and refreshes
  crypto prices.
- **AI normalization** — pluggable provider (rules / Claude API /
  Ollama) that cleans merchant names and categorizes transactions, plus
  a **conversational financial assistant** with 17 tenant-scoped,
  audit-logged tools.
- **Receipts** — drag-and-drop attachments with Claude-vision OCR +
  AES-256-GCM encryption at rest, mismatch flagging.
- **Wealth** — investment holdings (cost basis + mark-to-market), manual
  assets & liabilities, **multi-currency** with daily-refreshed FX
  rates, **retirement projections**, **crypto** tracking with daily
  CoinGecko price refresh.
- **Budgeting & cash flow** — flex budgets, weekly→monthly periods,
  budget-vs-actual, savings goals, bill reminders, AutoMagic wizard
  with fuel/toll math, 90-day forecast.
- **Reporting & insights** — dashboard charts, anomaly alerts,
  tax-category tagging + year-end Schedule A/C reports, calendar
  budget view, filtered CSV export, data portability tooling.
- **Mobile** — installable PWA with responsive UI, offline shell,
  install prompt.
- **Households & sharing** — multi-tenant with admin/spouse/child
  roles, **per-account read/read-write permission tuning**, **bill-
  splitting** with net-balance settlement, **cross-tenant isolation
  verified** by a dedicated security test suite.
- **Ops** — single-container Docker stack, Argon2id auth, super-admin
  audit log, GUI-managed backups + runtime settings, live health
  dashboard, SMTP for alerts.

See the [Roadmap](./docs/ROADMAP.md) for the full phase history and
[Changelog](./CHANGELOG.md) for what landed when.

## Documentation

| Document | What it covers |
|----------|----------------|
| [Quick Start](./docs/QUICKSTART.md) | Get running in ~5 minutes |
| [Installation Guide](./docs/INSTALLATION.md) | Full step-by-step setup |
| [General Documentation](./docs/DOCUMENTATION.md) | Architecture, data model, API reference |
| [Admin Guide](./docs/ADMIN_GUIDE.md) | Operations, backups, security, troubleshooting |
| [Testing Guide](./docs/TESTING.md) | Test suite, how to run it, exploratory charters |
| [Process Playbook](./docs/PROCESS.md) | The 16-stage feature lifecycle, branching, versioning, DoD |
| [Contributing](./docs/CONTRIBUTING.md) | Brief entry point for new work |
| [Changelog](./CHANGELOG.md) | Release notes per version |
| [Feature List](./docs/FEATURES.md) | What works now vs. what's planned |
| [Roadmap](./docs/ROADMAP.md) | The nine-phase plan |
| [Known Issues](./docs/KNOWN_ISSUES.md) | Current limitations & planned fixes |

## Quick start

**Production (single container):**

```powershell
Copy-Item .env.example .env
# Generate a session secret + attachment key (paste into .env)
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('ATTACHMENT_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
docker compose -p smrtcash up -d --build
```

Then open **http://localhost:4000** and set your password on the first
screen.

**Development (hot reload, no container build):**

```powershell
Copy-Item .env.example .env
docker compose -p smrtcash up -d db
npm install --prefix server
npm install --prefix web
npm run migrate --prefix server
npm run dev --prefix server   # terminal 1
npm run dev --prefix web      # terminal 2
```

Then open **http://localhost:5173**. Full details in the
[Quick Start](./docs/QUICKSTART.md).

## Architecture

- **server/** — Fastify + TypeScript API
- **web/** — React + Vite + TypeScript frontend
- **PostgreSQL 17** — runs as a dedicated docker-compose service
- Money is stored as **integer cents** — never floating point.

## Testing

~630 automated tests spanning unit, integration, functional, security
(incl. **72 cross-tenant isolation tests**), smoke, performance, and
end-to-end layers — full server suite passes cleanly. With PostgreSQL
running:

```sh
npm test            # server + web tests
npm run test:e2e    # browser end-to-end tests
```

See the [Testing Guide](./docs/TESTING.md) for the full strategy, commands,
and exploratory-testing charters.

## Security notes

- `.env` is gitignored — never commit real credentials.
- The `samples/` folder is gitignored — never commit real financial exports.
- `SESSION_SECRET` and `ATTACHMENT_ENCRYPTION_KEY` must be set in `.env`
  for a real deployment; the README quick-start shows how to generate them.
- Database encryption at rest is via the host volume (LUKS / BitLocker /
  FileVault / encrypted ZFS) — not in-app. Put HTTPS (Caddy / nginx) in
  front and set `COOKIE_SECURE=1`.

See the [Admin Guide](./docs/ADMIN_GUIDE.md#security-checklist) for the full
security checklist, HTTPS-via-Caddy snippet, and dependency vulnerability
policy.
