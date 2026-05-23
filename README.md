# SmrtCash

A self-hosted personal finance manager (in the spirit of Quicken / Monarch).
Import bank & credit-card exports, let AI normalize messy transaction
descriptions, attach receipts, and see where your money goes — all running in
your own container, with your data staying on your machine.

## Status

**Phases 1 through 6 — Foundation, Import, AI Normalization, Receipts, Insights, Auth & Hardening, Budgeting & Cash Flow** ✅ Complete

The stack is live, verified, and **safe to deploy**: accounts with **true
opening-balance reconciliation**, a CSV/XLSX importer with automatic
bank-format detection, duplicate protection, a web UI for browsing
transactions, **a pluggable AI normalization layer (rules / Claude API /
Ollama)** that cleans merchant names and categorizes transactions, a
user-editable category taxonomy, inline manual editing, **drag-and-drop
receipt attachments with Claude-vision OCR + AES-256-GCM encryption at
rest** that flags receipts whose amount or date don't match the
transaction, **automatic transfer detection** between own accounts, a
**dashboard** with spending-by-category, income-vs-expense, and
net-worth-over-time charts plus filtered CSV export, **Argon2id
single-user authentication** with first-boot password setup, a
**single-container Docker image** ready for `docker compose up`, and
**flex budgeting + budget-vs-actual + savings goals + bill reminders +
90-day cash-flow forecast** rounding out the everyday-finance experience.
See the [Roadmap](./docs/ROADMAP.md) for what's next.

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

349 automated tests spanning unit, integration, functional, security, smoke,
performance, and end-to-end layers. With PostgreSQL running:

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
