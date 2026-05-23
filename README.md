# SmrtCash

A self-hosted personal finance manager (in the spirit of Quicken / Monarch).
Import bank & credit-card exports, let AI normalize messy transaction
descriptions, attach receipts, and see where your money goes — all running in
your own container, with your data staying on your machine.

## Status

**Phases 1, 2, 3, and 4 — Foundation, Import, AI Normalization, Receipts, Insights** ✅ Complete

The stack is live and verified: accounts with **true opening-balance
reconciliation**, a CSV/XLSX importer with automatic bank-format detection,
duplicate protection, a web UI for browsing transactions, **a pluggable AI
normalization layer (rules / Claude API / Ollama)** that cleans merchant
names and categorizes transactions, a user-editable category taxonomy,
inline manual editing, **drag-and-drop receipt attachments with
Claude-vision OCR** that flags receipts whose amount or date don't match
the transaction, **automatic transfer detection** between own accounts,
and a **dashboard** with spending-by-category, income-vs-expense, and
net-worth-over-time charts plus filtered CSV export. See the
[Roadmap](./docs/ROADMAP.md) for what's next.

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

227 automated tests spanning unit, integration, functional, security, smoke,
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
- Phase 1 has **no authentication** — run it only on localhost / a trusted
  LAN. Authentication and encryption at rest arrive in Phase 5.

See the [Admin Guide](./docs/ADMIN_GUIDE.md#security-checklist) for the full
security checklist.
