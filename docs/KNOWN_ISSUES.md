# SmrtCash — Known Issues

This page tracks current limitations as of **0.14.7 (2026-05-23)**.

**No open issues at the moment.** The original KI-02 / KI-05 / KI-06 / KI-07 /
KI-08 list has been retired in full — see the Resolved section below.

Severity: 🔴 high · 🟡 medium · 🟢 low / cosmetic. Add new findings as they
surface.

---

## Resolved

### ~~KI-02 — Moderate npm vulnerabilities in `exceljs` dependencies~~ ✅ resolved in 0.14.7

Both moderate-severity advisories traced to `uuid <11.1.1` used transitively
by exceljs. Resolved by an npm `overrides` block in `server/package.json`
forcing `uuid` to `^11.1.1`. `npm audit` now reports **0 vulnerabilities**.

### ~~KI-05 — Duplicate detection is heuristic~~ ✅ resolved in 0.14.7

The dedup hash now uses the **bank-provided reference** (`FITID` for OFX,
`transaction_id` for Plaid) as the canonical identity when present, falling
back to the `(date, amount, description)` heuristic only for sources that
don't provide one (CSV, XLSX, QIF). Re-importing the same OFX file or syncing
an overlapping Plaid window is now deterministically idempotent EVEN if the
bank later rewrites the description (merchant-name cleanup post-settlement,
correction postings, etc.). Covered by 4 new unit tests in
`tests/unit/dedup.test.ts`.

**Note for existing imports:** if you previously imported the same OFX file
under the heuristic logic, re-importing it post-fix will skip rows whose
FITID-based hash matches a new row but produce duplicates for any rows that
already existed under the old hash. In practice this is negligible — most
re-imports happen between fix-and-prod within the same session — but a bulk-
delete on the duplicates closes any residual.

### ~~KI-06 — XLSX date cells may need verification~~ ✅ resolved in 0.14.7

The XLSX parser's `cellToString` already extracted dates via `getUTC*`
methods (correct since 0.11.0), but the behavior was never pinned by a
test. Added `tests/unit/xlsx-date-parsing.test.ts` covering year-start,
year-end, month boundaries, and a leap day. Round-trips through exceljs
without committing a binary fixture. All 5 dates parse verbatim.

### ~~KI-07 — Single-user / single-household assumption~~ ✅ resolved in Phase 8 / 0.14.x

Multi-tenant with admin / spouse / child roles shipped in Phase 8 (0.11.0).
Per-account permission tuning landed in 0.13.4. **Cross-tenant isolation was
audited and hardened in 0.14.0 → 0.14.4** — 72 dedicated cross-tenant tests
in `tests/security/tenant-isolation.test.ts` verify that no route, no domain
function, and no aggregation leaks data across tenants. Each test would have
failed against pre-0.14.x code.

### ~~KI-08 — Project folder name contains `$`~~ ✅ retired as accepted-by-design in 0.14.7

The working directory `SmrtCa$h` is handled by always passing
`-p smrtcash` to docker compose and by quoting paths. Internal package /
container names are `smrtcash`. No code change required; treating this as
a documented convention rather than an outstanding issue.

### ~~Portability tests fail on Windows-dev (tar shell-out)~~ ✅ resolved in 0.14.5

Three tar shell-outs in `domain/portability.ts`, `domain/backup-runner.ts`,
and the portability test now pass `--force-local` so GNU tar doesn't
interpret a Windows drive-letter colon (`C:\...`) as an SSH-style `host:path`.
Safe on Linux (no-op when no colon is present in arguments).

---

*Found something not listed here? It belongs in this file — keep it updated
as the project evolves.*
