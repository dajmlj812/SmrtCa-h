# SmrtCash — Known Issues

This page tracks current limitations as of **0.14.4 (2026-05-23)**.
Each item lists its impact, a workaround if any, and the planned resolution.

Severity: 🔴 high · 🟡 medium · 🟢 low / cosmetic

---

## KI-02 — Moderate npm vulnerabilities in `exceljs` dependencies 🟡

**Description:** `npm audit` reports 2 moderate-severity advisories in
transitive dependencies of `exceljs` (the XLSX parser), e.g. `fstream`.

**Impact:** Affects only the Excel import path. CSV import — the primary path —
is unaffected. No untrusted input reaches these libraries unless you import an
XLSX file.

**Workaround:** Import CSV exports rather than XLSX where possible.

**Planned resolution:** Replace `exceljs` with a smaller maintained XLSX
library, or vendor a patched dependency tree. Run `npm audit` in CI per the
[dependency vulnerability policy](./ADMIN_GUIDE.md#dependency-vulnerability-policy).

---

## KI-05 — Duplicate detection is heuristic 🟢

**Description:** A transaction's identity is a hash of date + amount +
description, with an occurrence counter for genuinely identical rows in one
file. There is no globally unique transaction ID from the bank.

**Impact:** Re-importing the same file is always safe (nothing duplicated).
Edge case: importing two *different* exports with overlapping date ranges that
each contain distinct-but-identical transactions could, in rare cases,
mis-count one as a duplicate.

**Workaround:** Prefer non-overlapping export date ranges when importing.

**Planned resolution:** Honor bank-provided reference numbers where available.

---

## KI-06 — XLSX date cells may need verification 🟢

**Description:** Excel stores dates as serial numbers; conversion to a calendar
date can be off by a day in unusual locale/timezone combinations.

**Impact:** Only affects `.xlsx` imports. CSV dates (the Chase exports) are
parsed from plain text and are unaffected.

**Workaround:** Use the import **preview** to spot-check dates before
committing. Import CSV when available.

**Planned resolution:** Hardened XLSX date handling alongside KI-02.

---

## KI-08 — Project folder name contains `$` 🟢

**Description:** The working directory is `SmrtCa$h`. The `$` character is
special in PowerShell, in URLs, and in some Docker contexts.

**Impact:** Cosmetic. It is handled by always passing an explicit Docker Compose
project name (`-p smrtcash`) and by quoting paths. The package/internal name is
`smrtcash`.

**Workaround:** Use `docker compose -p smrtcash ...` as documented. Optionally
rename the folder to `smrtcash`.

**Planned resolution:** None required; documented convention.

---

## Resolved

### ~~KI-07 — Single-user / single-household assumption~~ ✅ resolved in Phase 8 / 0.14.x

Multi-tenant with admin / spouse / child roles shipped in Phase 8 (0.11.0).
Per-account permission tuning landed in 0.13.4. **Cross-tenant isolation was
audited and hardened in 0.14.0 → 0.14.4** — 72 dedicated cross-tenant tests in
`tests/security/tenant-isolation.test.ts` verify that no route, no domain
function, and no aggregation leaks data across tenants. Each test would have
failed against pre-0.14.x code.

### ~~Portability tests fail on Windows-dev (tar shell-out)~~ ✅ resolved in 0.14.5

The three tar shell-outs in `domain/portability.ts`, `domain/backup-runner.ts`,
and the portability test now pass `--force-local` so GNU tar doesn't interpret
a Windows drive-letter colon (`C:\...`) as an SSH-style `host:path`. Safe on
Linux (no-op when no colon is present in arguments).

---

*Found something not listed here? It belongs in this file — keep it updated as
the project evolves.*
