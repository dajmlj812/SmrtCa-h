# SmrtCash

A hosted personal-finance manager (in the spirit of Quicken / Monarch).
Connect a bank or import statements, let AI normalize messy transaction
descriptions, attach receipts, and see where your money goes. SmrtCash
is a **managed SaaS** — sign up at
[smrtcash.builditsmrt.com](https://smrtcash.builditsmrt.com), start your
14-day trial, and your data lives in our encrypted, per-tenant-isolated
infrastructure. Nothing to install.

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
  target utilization %. Your data is encrypted at rest and isolated
  per tenant on our managed infrastructure.
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
| [Quick Start](./docs/QUICKSTART.md) | Sign up + first import in ~5 minutes |
| [General Documentation](./docs/DOCUMENTATION.md) | Architecture, data model, API reference |
| [Feature List](./docs/FEATURES.md) | What works now vs. what's planned |
| [Changelog](./CHANGELOG.md) | Release notes per version |
| [Roadmap](./docs/ROADMAP.md) | The phase + release history |
| [Terms of Service](./docs/TERMS_OF_SERVICE.md) | Customer terms |
| [Privacy Policy](./docs/PRIVACY_POLICY.md) | How we handle your data |

Operator + contributor docs (deploy, runbooks, admin guide, testing,
process, Stripe setup, known issues) live alongside these in
[`docs/`](./docs/). They're internal and are not published to the public
docs site.

## Using SmrtCash

SmrtCash is a hosted service. To use it, **sign up at
[smrtcash.builditsmrt.com](https://smrtcash.builditsmrt.com)** — there's
nothing to install. See the [Quick Start](./docs/QUICKSTART.md) for the
onboarding walkthrough.

> Self-hosting is no longer supported. SmrtCash runs only as the managed
> SaaS operated by BuildITSmrt, LLC.

## Architecture

- **server/** — Fastify + TypeScript API
- **web/** — React + Vite + TypeScript frontend (installable PWA)
- **PostgreSQL 17** — managed database; per-tenant data isolation
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

## Security (how we protect your data)

- **Per-tenant isolation** — every read and write is scoped to your
  household; cross-tenant access is verified by a dedicated test suite.
- **Encryption** — attachments and connection secrets are encrypted with
  AES-256-GCM (per-tenant envelope keys); the database is encrypted at
  rest on managed infrastructure; all traffic is HTTPS.
- **Authentication** — Argon2id password hashing, signed HttpOnly session
  cookies, anti-enumeration on signup + password reset.
- **You can leave with your data** — download a full `.smrtcash` export
  any time.

Operator security details (key management, deploy hardening, the security
checklist) live in the _internal_ [Admin Guide](./docs/ADMIN_GUIDE.md#security-checklist).
