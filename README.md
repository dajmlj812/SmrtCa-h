# SmrtCash

A personal-finance manager (in the spirit of Quicken / Monarch).
Import bank & credit-card exports, let AI normalize messy transaction
descriptions, attach receipts, and see where your money goes — runs
**self-hosted** on hardware you control **or as a SaaS** on
infrastructure the operator deploys.

## Status

**Current release: 0.24.4** — phases 1–9, hardening, SaaS pivot
(0.15.x), launch readiness (0.16.x), competitive-parity work
(0.18.x), reconciliation + investment analysis (0.19.x), agentic AI
moat (0.20.x), universal customer asks (0.21.x), production-launch
readiness (0.22.x), and the scenario-expansion arc (0.24.x) all
shipped. Next planned arc is **0.25.x — credit-score + retirement
scenarios**. **Scaling work is queued as 0.26.x** for after feature
work.

What ships today:

- **Import & connectivity** — CSV / XLSX / OFX / QFX / QIF import with
  bank-format auto-detection and duplicate protection; **OFX Direct
  Connect**; **opt-in Plaid integration**; **scheduled background
  sync** with per-source cadence + daily crypto-price refresh.
- **AI normalization** — pluggable provider (rules / Claude API /
  Ollama) that cleans merchant names and categorizes transactions,
  plus a **conversational financial assistant** with tenant-scoped
  audit-logged tools. **Manual renames auto-learn** into the
  normalization rule set so future imports inherit them.
- **Receipts** — drag-and-drop attachments with Claude-vision OCR +
  **per-tenant envelope encryption** (AES-256-GCM DEK wrapped by a
  global KEK; super-admin can rotate any tenant's key without touching
  others), mismatch flagging.
- **Wealth** — investment holdings (cost basis + mark-to-market),
  manual assets & liabilities, **multi-currency** with daily-refreshed
  FX rates, **retirement projections**, **crypto** tracking, **credit
  card payoff goals** that auto-track current balance toward $0 or a
  target utilization %.
- **Budgeting & cash flow** — flex budgets, weekly→monthly periods,
  budget-vs-actual, savings goals with **28 curated templates**,
  AutoMagic wizard with fuel/toll math, 90-day forecast.
- **Bill matching engine** — `/recurring` (Bills + Subscriptions
  unified) with per-bill amount-mode (fixed / drift / variable),
  match-window, merchant pattern. Auto-links incoming transactions
  and queues the ambiguous ones for review. Drift-mode bills track
  the latest matched amount automatically.
- **What-if scenarios** — `/scenarios` hub with 13 calculators:
  invest $X/mo, bump 401(k), windfall split, FIRE date, balance
  transfer, debt consolidation, biweekly mortgage, have a kid, buy a
  house, job change, sabbatical, recession stress test, plus the
  cash-flow projector.
- **Reporting & insights** — **17 canned reports** (year-over-year,
  month-over-month movers, day-of-week pattern, tax-deductible YTD,
  savings rate, income sources, first-time merchants, refunds YTD,
  bill price drift, debt-balance over time, average txn, plus the
  originals); **dashboard charts**, **daily anomaly scan**,
  **tax-category tagging** + Schedule A/C reports, **editable
  per-tenant IRS mileage rates**, calendar budget view, CSV export,
  full data portability (`.smrtcash` bundle).
- **Mobile** — installable PWA with responsive UI, offline shell,
  install prompt.
- **Households & sharing** — multi-tenant with admin/spouse/child
  roles, **per-account read/read-write permission tuning**,
  **bill-splitting**, **cross-tenant isolation verified** by a
  dedicated security test suite.
- **SaaS billing** — three tiers (Starter / Plus / Family), Stripe
  Checkout + Customer Portal, 14-day trial, dunning emails +
  3-day grace, per-tenant metered usage with cap-overflow warnings.
- **Public signup + self-service** — `/signup` (gated by
  `PUBLIC_SIGNUP_ENABLED`), email verification, password reset, all
  with anti-enumeration response shapes.
- **Operator surface** — super-admin **subscriptions console** +
  **SaaS health dashboard** + runtime-editable settings; full
  operator runbook with playbooks for the common SaaS incidents.

See the [Roadmap](./docs/ROADMAP.md) for the full phase history and
[Changelog](./CHANGELOG.md) for what landed when.

## Documentation

| Document | What it covers |
|----------|----------------|
| [Quick Start](./docs/QUICKSTART.md) | Get running in ~5 minutes |
| [Installation Guide](./docs/INSTALLATION.md) | Full step-by-step setup |
| [General Documentation](./docs/DOCUMENTATION.md) | Architecture, data model, API reference |
| [Admin Guide](./docs/ADMIN_GUIDE.md) | Operations, backups, security, troubleshooting |
| [Operator Runbook](./docs/OPERATOR_RUNBOOK.md) | SaaS-mode playbooks: webhook failures, customer-no-access, encryption rotation, dunning, grace window |
| [SaaS Plan](./docs/SAAS_PLAN.md) | Pricing tiers + feature gating (source of truth for paywall) |
| [Stripe Setup](./docs/STRIPE_SETUP.md) | Initial Stripe configuration walkthrough |
| [Testing Guide](./docs/TESTING.md) | Test suite, how to run it, exploratory charters |
| [Process Playbook](./docs/PROCESS.md) | The 16-stage feature lifecycle, branching, versioning, DoD |
| [Contributing](./docs/CONTRIBUTING.md) | Brief entry point for new work |
| [Changelog](./CHANGELOG.md) | Release notes per version |
| [Feature List](./docs/FEATURES.md) | What works now vs. what's planned |
| [Roadmap](./docs/ROADMAP.md) | The phase + release history |
| [Known Issues](./docs/KNOWN_ISSUES.md) | Current limitations & planned fixes |
| [Terms of Service](./docs/TERMS_OF_SERVICE.md) | Placeholder — replace with lawyer copy before commercial launch |
| [Privacy Policy](./docs/PRIVACY_POLICY.md) | Placeholder — replace with lawyer copy before commercial launch |

> **Static HTML versions** of every doc above live at
> [`docs/html/`](./docs/html/) for direct hosting on a marketing
> site. Regenerate with `npm run docs:html` after editing any
> `.md` source.

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

Automated server tests + web tests spanning unit, integration,
functional, security (incl. cross-tenant isolation tests), smoke,
performance, and end-to-end layers — full suite passes cleanly.
With PostgreSQL running:

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
