# SmrtCash — Testing Guide

How SmrtCash is tested, how to run the suite, and how to extend it.

As of **Phase 1** the suite has **95 automated tests**: 83 server, 6 web,
6 end-to-end — all passing.

---

## 1. Philosophy

**Automated first.** Machine-run tests are repeatable and cheap, so the bulk
of testing is automated and runs on every change.

**The testing pyramid.** Many fast, low-level tests; fewer slow, high-level
ones. Unit tests catch most regressions instantly; a handful of end-to-end
tests prove the whole system holds together.

**Try to break it.** Good tests do not just confirm the happy path — they
feed the app bad data, hostile input, and unexpected actions and check that it
degrades gracefully instead of crashing or corrupting data.

**Tests are code.** They are reviewed, kept clean, and never run against real
financial data — every layer uses synthetic fixtures and isolated databases.

---

## 2. Test types and how SmrtCash implements them

| Type | Where | Tooling | What it covers |
|------|-------|---------|----------------|
| **Unit** | `server/tests/unit/` | Vitest | Pure functions: cents parsing, date parsing, dedup hashing, format detection |
| **Integration** | `server/tests/integration/` | Vitest + Fastify inject | API routes against a real test database |
| **Functional** | `server/tests/functional/` | Vitest | Business outcomes — exact counts and balances from imports |
| **End-to-end** | `e2e/` | Playwright | Real browser driving the whole stack |
| **Smoke** | `server/tests/smoke/`, `e2e/tests/smoke.spec.ts` | Vitest / Playwright | Fast "are the major features alive?" check |
| **Security** | `server/tests/security/` | Vitest | SQL-injection, malformed input, abuse, oversized data |
| **Performance** | `server/tests/performance/` | Vitest | Large-file import and query timing |
| **Acceptance** | [§7](#7-acceptance-checklist) | Checklist | Formal sign-off against business requirements |
| **Manual / Exploratory** | [§8](#8-exploratory-testing-charters) | Human | Unscripted hunting for non-obvious defects |

### Unit
Lowest level, no I/O, milliseconds to run. Example: every form of a money
string (`"$1,419.00"`, `"(12.34)"`, `"-9.99"`) maps to the correct integer
cents, and `0.10 + 0.20` in cents exactly equals `0.30` (no float drift).

### Integration
Builds the real Fastify app and drives it with `app.inject()` — no network,
but real routes and a real PostgreSQL database. Verifies status codes,
validation, and that modules (routes → importer → database) work together.

### Functional
Also database-backed, but asserts **product-defined outcomes**: importing the
sample credit-card file yields *exactly* 8 transactions and a balance of
*exactly* `$260.68`. Where an integration test checks "the database can be
queried", a functional test checks "the answer is the one the spec requires".

### End-to-end
Playwright starts the API and web app on isolated ports and drives a real
Chromium browser through complete user journeys: create an account, upload a
file, confirm the import, view the transactions.

### Security
Deliberately hostile: SQL-injection strings in search parameters and account
names, wrong-typed JSON fields, 50,000-character inputs, non-CSV uploads,
path-traversal filenames. Each asserts graceful handling — never a 500 crash,
never data loss. (Writing these surfaced and fixed a real hardening gap in the
accounts route.)

### Performance
Generates a 5,000-row statement, imports it, and asserts both correctness and
that it completes well within a generous time budget — catching catastrophic
regressions without flaky timing assertions.

---

## 3. Test databases

Tests never touch your real data. Two throwaway databases are created
automatically in the same PostgreSQL container:

| Database | Used by | Lifecycle |
|----------|---------|-----------|
| `smrtcash` | The real app | Your actual data |
| `smrtcash_test` | Vitest (server) | Created on first run; truncated between tests |
| `smrtcash_e2e` | Playwright | Created and cleaned before each e2e run |

A safety guard (`server/tests/setup/test-db.ts`) aborts the suite immediately
if it is ever pointed at a database whose name does not end in `_test`.

---

## 4. Running the tests

**Prerequisite:** the PostgreSQL container must be running —
`docker compose -p smrtcash up -d db`.

### From the repo root

```sh
npm test            # all server + web tests
npm run test:e2e    # end-to-end browser tests
npm run test:all    # everything
```

### Server suite

```sh
npm run test --prefix server              # all 83 server tests
npm run test:unit --prefix server         # unit only
npm run test:integration --prefix server  # integration only
npm run test:functional --prefix server   # functional only
npm run test:security --prefix server     # security only
npm run test:smoke --prefix server        # smoke only (fastest signal)
npm run test:perf --prefix server         # performance only
npm run test:coverage --prefix server     # with a coverage report
npm run test:watch --prefix server        # re-run on file changes
```

### Web suite

```sh
npm run test --prefix web
```

### End-to-end suite

```sh
npm run test --prefix e2e            # headless
npm run test:headed --prefix e2e     # watch the browser
npm run test:ui --prefix e2e         # interactive Playwright UI
npm run report --prefix e2e          # open the last HTML report
```

The first e2e run needs the browser installed once:
`npm run install:browser --prefix e2e`.

---

## 5. Project layout

```
server/
  vitest.config.ts            Vitest config + test-database wiring
  tests/
    setup/                    global setup, DB helpers, fixtures loader
    fixtures/                 synthetic CSV files (safe to commit)
    unit/  integration/  functional/  security/  smoke/  performance/
web/
  vitest.config.ts
  tests/unit/                 display-formatting tests
e2e/
  playwright.config.ts        Playwright config + web servers
  setup-db.mjs                creates/cleans the e2e database
  tests/                      browser specs
```

---

## 6. Writing new tests

- **Pick the lowest layer that can cover the behavior.** Pure logic → unit.
  A route → integration. A user journey → e2e.
- **Use the fixtures** in `server/tests/fixtures/`; add new synthetic ones as
  needed. Never commit real financial data.
- **Database tests** `import { resetDb }` and call it in `beforeEach` for
  isolation.
- **Cover the unhappy path** — invalid input, missing fields, duplicates.
- **Keep tests deterministic** — no reliance on clock, ordering, or leftover
  state.
- Tests are part of code review — review them like production code.

---

## 7. Acceptance checklist

Formal Phase 1 sign-off. Every item below is also covered by an automated
test, but this checklist is the human-readable contract.

- [ ] An account can be created for each type (checking, savings, credit card, …)
- [ ] A Chase credit-card CSV export imports successfully
- [ ] A Chase checking/savings CSV export imports successfully
- [ ] A non-Chase file imports via custom column mapping
- [ ] The import preview shows the detected format and row counts before saving
- [ ] Re-importing the same file adds no duplicate transactions
- [ ] A file with bad rows imports the good rows and reports the bad ones
- [ ] Transactions are listed, searchable, and paginated
- [ ] Account balance and transaction count are displayed
- [ ] Money is always exact — no floating-point rounding errors
- [ ] Deleting an account removes its transactions
- [ ] The app does not crash on malformed or hostile input

---

## 8. Exploratory testing charters

Automated tests confirm what we *expect*; exploratory testing finds what we
did not think of. Run a focused, time-boxed session (**60–90 minutes, never
more than two hours**) against one charter at a time, and log every surprise.

### Charter A — Importing
*Explore the import flow with unusual files to discover parsing failures.*
Try: empty files, header-only files, huge files, files with extra columns,
different date formats, negative and zero amounts, non-UTF-8 encodings,
`.xlsx` exports, wrong file extensions, and double-clicking Import.

### Charter B — Accounts & transactions
*Explore account and transaction management to discover state and navigation
bugs.* Try: many accounts, very long names, deleting an account mid-view,
browser back/forward, search with punctuation and wildcards (`%`, `_`),
pagination at the first/last page, and refreshing on a detail page.

### Charter C — Data integrity & display
*Explore how money and dates are shown to discover correctness bugs.* Try:
large balances, exactly-zero balances, all-negative accounts, transactions on
the same day, month boundaries, and confirm displayed totals match the
underlying data.

For each session record: what was tested, what surprised you, and any defect
worth filing in [KNOWN_ISSUES.md](./KNOWN_ISSUES.md).

---

## 9. Continuous integration

The suite is CI-ready — every command above exits non-zero on failure. A CI
job needs only a PostgreSQL service plus:

```sh
npm ci --prefix server && npm ci --prefix web
npm test
npm run test:e2e
```

No CI provider config ships yet (deferred by choice); adding a GitHub Actions
or Bitbucket Pipelines file is a small, self-contained follow-up.

---

*See also: [DOCUMENTATION.md](./DOCUMENTATION.md) ·
[KNOWN_ISSUES.md](./KNOWN_ISSUES.md)*
