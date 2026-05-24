# SmrtCash Documentation

Start here, depending on what you need:

| If you want to… | Read |
|-----------------|------|
| Get it running fast | [QUICKSTART.md](./QUICKSTART.md) |
| Install it properly, step by step | [INSTALLATION.md](./INSTALLATION.md) |
| Understand how it's built | [DOCUMENTATION.md](./DOCUMENTATION.md) |
| Operate, back up, and secure it | [ADMIN_GUIDE.md](./ADMIN_GUIDE.md) |
| Run SmrtCash as SaaS (Stripe, signup, dunning, encryption) | [OPERATOR_RUNBOOK.md](./OPERATOR_RUNBOOK.md) |
| See the pricing tiers + feature gating | [SAAS_PLAN.md](./SAAS_PLAN.md) |
| Configure Stripe from scratch | [STRIPE_SETUP.md](./STRIPE_SETUP.md) |
| Run or extend the test suite | [TESTING.md](./TESTING.md) |
| Build a feature end-to-end | [PROCESS.md](./PROCESS.md) |
| Onboard as a contributor | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| See what it can do | [FEATURES.md](./FEATURES.md) |
| See where it's going | [ROADMAP.md](./ROADMAP.md) |
| Know the current limitations | [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) |
| Read release notes | [../CHANGELOG.md](../CHANGELOG.md) |

Up-to-date for **v0.16.4** (2026-05-24): SaaS pivot + launch readiness
complete (public signup, password reset, super-admin subscriptions
console, per-tenant attachment encryption, support visibility).

## HTML mirror

Static HTML versions of every doc above are generated to
[`html/`](./html/) by `npm run docs:html`. They use inline CSS
(no external requests), respect `prefers-color-scheme`, and
include a category-organized index page. The marketing site
serves these directly — re-run the script after editing any
`.md` source and commit the result.
