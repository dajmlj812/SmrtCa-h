# SmrtCash — Known Issues

This page tracks current limitations as of **Phase 1 (2026-05-22)**.
Each item lists its impact, a workaround if any, and the planned resolution.

Severity: 🔴 high · 🟡 medium · 🟢 low / cosmetic

---

## KI-01 — Account balance is "net of imported activity" 🟡

**Description:** An account's balance is computed as the sum of all imported
transaction amounts. It is **not** the institution's true current balance.

**Impact:** For a credit card imported from near account opening, the figure is
close to reality. For a checking account, it reflects net cash flow over the
imported period, not the actual balance. Net Worth inherits the same caveat.

**Workaround:** Treat the balance as "net change across imported transactions."
The accurate running balance is preserved per-transaction (`balance_cents`)
when the bank export includes it.

**Planned resolution:** Phase 4 — opening balances + statement running-balance
reconciliation.

---

## KI-02 — Moderate npm vulnerabilities in `exceljs` dependencies 🟡

**Description:** `npm audit` reports 2 moderate-severity advisories in
transitive dependencies of `exceljs` (the XLSX parser), e.g. `fstream`.

**Impact:** Affects only the Excel import path. CSV import — the primary path —
is unaffected. No untrusted input reaches these libraries unless you import an
XLSX file.

**Workaround:** Import CSV exports rather than XLSX where possible.

**Planned resolution:** Phase 5 hardening — replace `exceljs` with a smaller
maintained XLSX library, or vendor a patched dependency tree. Run
`npm audit` in CI.

---

## KI-03 — No authentication 🔴 (by design, for now)

**Description:** The app has no login. Anyone who can reach the web port can
view and modify all data.

**Impact:** Do **not** expose SmrtCash to the public internet or an untrusted
network in its current state.

**Workaround:** Run it only on `localhost` or a trusted LAN, behind a firewall.

**Planned resolution:** Phase 5 — single-user authentication (Argon2-hashed
password, session cookies).

---

## KI-04 — Migrations must be run via `npm run migrate` 🟢

**Description:** The TypeScript build (`npm run build`) compiles `.ts` files but
does not copy the `.sql` migration files into `server/dist/`.

**Impact:** Running migrations from the compiled output would fail. The provided
`npm run migrate` script uses `tsx` and reads migrations from `server/src/`, so
it works correctly — this only matters if you bypass that script.

**Workaround:** Always run database migrations with `npm run migrate`.

**Planned resolution:** Phase 5 — add a build step that copies migrations into
`dist/`, or embed them.

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

## KI-07 — Single-user / single-household assumption 🟢

**Description:** There is no concept of multiple users or per-user data
separation.

**Impact:** Everyone using the instance shares one dataset.

**Workaround:** Run separate instances for separate people if needed.

**Planned resolution:** Backlog — optional multi-user / household mode.

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

*Found something not listed here? It belongs in this file — keep it updated as
the project evolves.*
