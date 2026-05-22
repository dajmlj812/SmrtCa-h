# SmrtCash — Development Process

The playbook for going from "I want this feature" to "shipped, tagged,
documented." Optimized for a small team (currently a solo developer plus AI
assistance) — but the conventions scale to more.

Goals: **working software at every step**, no scary surprises at release time,
and a history that makes the next feature easier than the last.

> Where to start: the [Quick reference](#quick-reference-cheatsheet) at the
> bottom is enough to drive a routine feature. The full document explains
> *why* each step exists.

---

## 1. Overview

The lifecycle has **16 stages** grouped into five tracks:

| Track | Stages | What it produces |
|-------|--------|------------------|
| **A — Decide** | 1–3 | A clear, ready-to-build feature definition |
| **B — Build** | 4–7 | Working, tested code on a feature branch |
| **C — Review** | 8–11 | A reviewed, changelog'd, mergeable PR |
| **D — Release** | 12–16 | A tagged, pushed, released version |
| **E — Reflect** | post-merge | Updated docs & lessons captured |

Each stage has an **input**, an **output**, and a "definition of done" for
that stage alone — you should never leave a stage with unfinished work in it.

---

## 2. Roles

Even with one human developer, name the hats so each stage has a clear
"owner." The same person (or AI) can wear multiple hats per change.

| Hat | Owns |
|-----|------|
| **Product** | What to build, why, acceptance criteria. Stages 1–3. |
| **Developer** | Implementation + tests + docs. Stages 4–7. |
| **Reviewer** | Code review pass — second pair of eyes (human or `/code-review`). Stages 8, 10. |
| **Security reviewer** | Conditional — only for security-sensitive changes. Stage 9. |
| **Release manager** | Versioning, CHANGELOG, tagging, release notes. Stages 11–16. |

---

## 3. The 16 stages

### Stage 1 — Discover

**Input:** a user need, a competitor scan, an exploratory finding, a roadmap
backlog item.

**Output:** a one-paragraph **feature brief** added to
`docs/ROADMAP.md` (or its backlog) — *the why, not the how.*

### Stage 2 — Define

**Input:** an approved feature brief.

**Output:** a feature definition with:

- **Acceptance criteria** — concrete, checkable ("Importing a QIF file
  produces N transactions" not "QIF works")
- **Out of scope** — what we explicitly *aren't* building this time
- **Data model impact** — new columns, new tables, migrations needed
- **API surface** — new endpoints, request/response shapes
- **UX sketch** — if the change is user-visible (ASCII or wireframe)
- **Test layers** — which suites get new tests (unit/integration/functional/
  security/e2e); aim for the **lowest** layer that proves the behavior
- **TaskCreate entries** — one per slice the AI agent will execute

### Stage 3 — Definition of Ready (gate)

> Don't write code until every box is ticked.

- [ ] Feature is in `docs/ROADMAP.md`
- [ ] Acceptance criteria are written and concrete
- [ ] Out-of-scope is explicit
- [ ] Data-model / API impact is documented
- [ ] Test layers are identified
- [ ] Branch name decided (Stage 4)

If any box is open, go back to Stage 2.

### Stage 4 — Branch

```sh
git checkout main && git pull
git checkout -b feat/<phase>-<short-slug>
```

Branch names:

| Prefix | Use for |
|--------|---------|
| `feat/<phase>-<slug>` | Anything that delivers user value (`feat/3-receipt-upload`) |
| `fix/<slug>` | Non-urgent bug fix on `main` |
| `hotfix/<slug>` | Urgent fix against a released tag |
| `chore/<slug>` | Refactors, dependency bumps, doc-only changes |

### Stage 5 — Code

- Tests live in **the same change** as production code — never a follow-up.
- Touch docs as you go (`docs/FEATURES.md`, `docs/KNOWN_ISSUES.md`,
  `docs/ROADMAP.md` if anything shifts).
- Match the surrounding code's style — that's load-bearing.

### Stage 6 — Test

Pick the lowest layer that proves the behavior:

- Pure function → **unit** (Vitest)
- Route/handler → **integration** (Vitest + `app.inject`)
- Business outcome → **functional**
- User journey → **e2e** (Playwright)
- Hostile or malformed input → **security**

The test pyramid still applies: many fast unit tests, fewer end-to-end.

### Stage 7 — Local verify

Everything green locally before review.

```sh
npm run typecheck      # both packages
npm test               # server + web vitest
npm run test:e2e       # Playwright
```

For UI changes: `/verify` (drives the app) or `/run` (just launches it for a
manual look). For Phase 5+: also `docker compose build`.

### Stage 8 — Code review

1. **Self-review.** Re-read your own diff with fresh eyes.
2. **`/code-review`** — structured AI pass for correctness bugs.
3. **`/ultrareview`** — for big or risky changes; spins up a multi-agent
   cloud review of the branch.

Address every comment or explicitly note why you disagree. Don't move on with
unresolved review threads.

### Stage 9 — Security review (conditional)

Required when the change touches **any** of:

- Authentication, sessions, password handling
- Secrets / API keys / credentials
- File upload, attachment storage, file-system access
- A third-party API (Plaid, OFX direct, AI providers, etc.)
- SQL or any data-store query, especially with user-supplied input
- Cross-origin or auth-bearing HTTP requests

Run `/security-review`. The "try-to-break-it" mindset is the goal — feed bad
input, oversized payloads, hostile strings.

### Stage 10 — Fix issues

Push fixes to **the same branch**. Don't rewrite history pre-merge; squash
happens at merge time so the merge commit is the single unit on `main`.

### Stage 11 — CHANGELOG

Every PR adds a line under `## [Unreleased]` in `CHANGELOG.md`, in the
correct section (Added / Changed / Fixed / Removed / Security / Deprecated).
Style:

```
- Pluggable `TransactionNormalizer` interface with three providers (rules,
  Claude API, Ollama).
```

Required for every PR, including chores — the changelog is the source of
release notes.

### Stage 12 — Version (at release points only)

- **Phase release** → minor bump (`0.2.0` → `0.3.0`)
- **Bug-fix-only release** → patch bump (`0.2.0` → `0.2.1`)
- **1.0.0** — when feature-complete + hardened (after Phase 5)

When bumping, edit **all four** `package.json` files (root, `server/`,
`web/`, `e2e/`) in one commit, and move `## [Unreleased]` →
`## [X.Y.Z] — YYYY-MM-DD — <phase or theme name>` in `CHANGELOG.md`.

For PRs that aren't a release point, no version bump — the CHANGELOG entry
stays under "Unreleased" until the next release.

### Stage 13 — Build

```sh
npm run build --prefix server
npm run build --prefix web
```

Catches anything `npm test` doesn't (full bundle, no esbuild stripping). For
Phase 5+: also `docker compose build` to verify the container image builds.

### Stage 14 — Commit

**Conventional Commits.** One logical change per commit.

| Type | Use for |
|------|---------|
| `feat` | New user-visible capability |
| `fix` | Bug fix on shipped behavior |
| `docs` | Documentation only |
| `test` | Tests only (new or improved) |
| `refactor` | Internal restructure, no behavior change |
| `perf` | Performance improvement |
| `build` | Build system / dependency changes |
| `chore` | Routine maintenance, including release commits |

**Scope** is one of: `ai · accounts · transactions · import · categories · web · db · docs · test · build · release · ci`.

Examples:

```
feat(ai): add Claude normalizer with prompt caching
fix(import): handle blank balance column in Chase bank format
docs(roadmap): mark Phase 2 complete
test(security): cover SQL injection in search parameter
chore(release): 0.2.0
```

### Stage 15 — Merge

- Open a PR on GitHub against `main`.
- Use the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) — its checklist
  *is* the Definition of Done.
- **Squash-merge** the feature branch so `main`'s history is one commit per
  feature.
- Delete the feature branch after merge.

### Stage 16 — Push & release

```sh
# At a release point (after the squash-merge of the version bump):
git checkout main && git pull
git tag -a v0.3.0 -m "Phase 3 — Receipts & Attachments"
git push --follow-tags
```

Then on GitHub: **Releases → Draft a new release → choose tag `v0.3.0`**,
paste that version's CHANGELOG section as the body. Update
`docs/ROADMAP.md` to mark the phase complete and the next one as `🔜 Next`.

Phase 5+: build & push the Docker image too.

### Stage 17 (Track E) — Retrospective

Lightweight — never a meeting. After a release:

- One line in the release notes or the merge commit: *what surprised me /
  what I'd do differently.*
- Anything newly-discovered → add to `docs/KNOWN_ISSUES.md` with a `KI-NN`
  entry.
- Anything worth doing differently next time → adjust this `PROCESS.md`.

---

## 4. Definition of Done (merge gate)

Lives in `.github/PULL_REQUEST_TEMPLATE.md` so it shows up on every PR:

- [ ] Acceptance criteria met
- [ ] Tests cover the change (lowest meaningful layer)
- [ ] `npm run typecheck` clean (server + web)
- [ ] `npm test` clean (server + web)
- [ ] `npm run test:e2e` clean (if UI changed)
- [ ] Docs updated (Features / Roadmap / Known Issues as applicable)
- [ ] CHANGELOG entry added under `## [Unreleased]`
- [ ] `/code-review` run and findings addressed
- [ ] `/security-review` run if the change touches the security-sensitive list (Stage 9)
- [ ] PR description summarizes Summary / What changed / Tests / Screenshots (if UI) / Breaking changes / Linked phase

---

## 5. Versioning (Semantic Versioning)

`MAJOR.MINOR.PATCH`:

- **PATCH** — backward-compatible bug fixes (`0.2.0` → `0.2.1`)
- **MINOR** — backward-compatible new features; a phase ships as a minor bump (`0.2.0` → `0.3.0`)
- **MAJOR** — breaking changes; `1.0.0` arrives when the product is
  feature-complete and Phase 5 hardening is done

Anchor points:

| Version | Marker |
|---------|--------|
| `0.1.0` | Phase 1 — Foundation & Import |
| `0.2.0` | Phase 2 — AI Normalization (current) |
| `0.3.0` | Phase 3 — Receipts & Attachments |
| … one minor per phase … | |
| `1.0.0` | Feature-complete + hardened (post-Phase 5) |

---

## 6. CHANGELOG discipline

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Sections per release (omit empty ones):

- **Added** — new capabilities
- **Changed** — behavioral changes to existing capabilities
- **Fixed** — bug fixes
- **Removed** — capabilities deleted
- **Deprecated** — marked for removal but still working
- **Security** — vulnerability fixes
- **Migration notes** — anything operators must do when upgrading

A release entry is the release notes — write it for the person reading the
GitHub release page, not for the team that built it.

---

## 7. Release types

### Phase release (minor bump, the common case)

Schedule of changes accumulated since the last phase release. Tag on the
squash-merge of the version-bump PR.

### Maintenance release (patch bump)

Bug fixes or small adjustments that don't introduce features. Multiple fixes
can ride one patch release; cut a patch whenever the bug-fix backlog is worth
publishing.

### Hotfix (urgent patch)

When a critical bug ships in a release and `main` has already moved on:

```sh
git checkout v0.2.0                     # released tag
git checkout -b hotfix/<slug>           # off the tag, not off main
# fix + tests
# bump patch → 0.2.1, update CHANGELOG
git tag v0.2.1 && git push --follow-tags
# then merge the hotfix branch into main so main has the fix too
```

---

## 8. Rollback

- Tags are the rollback point: `git checkout vX.Y.Z` reproduces that build.
- Migrations are **forward-only.** Any migration that's hard to reverse
  manually must say so in the CHANGELOG under **Migration notes**, with the
  recovery procedure.
- The Postgres data volume is the durable state — back up before any release
  that changes the schema (see `docs/ADMIN_GUIDE.md` § Database backup).

---

## 9. Hooked tools (which Claude Code skill fits where)

| Stage | Skill / tool |
|-------|--------------|
| 1, 2 | `AskUserQuestion` (forks where your answer changes the spec) |
| 2 | `TaskCreate` / `TaskUpdate` (slice the work) |
| 5, 6 | regular Edit/Write + Vitest + Playwright |
| 7 | `/verify` (drive the app), `/run` (just launch) |
| 8 | `/code-review` (local AI pass), `/ultrareview` (cloud multi-agent) |
| 9 | `/security-review` (security-sensitive changes only) |
| 14 | git (no skill needed) |
| 16 | git tag + GitHub Releases |

---

## 10. Worked example — adding "OFX file import" in Phase 3

> Hypothetical walkthrough. Real Phase 3 will have its own spec.

1. **Discover (1).** Roadmap already lists OFX import under Phase 8; pull it
   forward because it's cheap and unlocks the Quicken-migration story.
2. **Define (2).** Acceptance: "An OFX file uploaded via the existing import
   wizard produces correctly-signed integer-cents transactions and is
   detected automatically." Out of scope: OFX Direct Connect (just file
   import). Data model: no change. API: no change. Tests: unit for the OFX
   parser, integration via `/api/imports/preview` and `/commit`, functional
   test with a synthetic OFX fixture.
3. **Ready (3).** Tick all boxes.
4. **Branch (4).** `git checkout -b feat/3-ofx-import`.
5. **Code + test (5, 6).** Add `server/src/import/parse-ofx.ts`, register
   it in `parse.ts`, add a format registry entry, write `tests/unit/
   parse-ofx.test.ts` and `tests/functional/ofx-import.test.ts`.
6. **Verify (7).** `npm run typecheck && npm test`.
7. **Code review (8).** Run `/code-review`. Fix the two findings.
8. **Security (9).** OFX is parsed XML from user upload — yes, run
   `/security-review`. Add a malformed-OFX security test if needed.
9. **CHANGELOG (11).** `Added: OFX (.ofx, .qfx) import alongside CSV/XLSX.`
10. **PR & merge (15).** Open PR, DoD checklist ticks, squash-merge.
11. **Version (12).** This is a Phase 3 mid-feature, not a release point —
    no version bump yet. The entry stays under "Unreleased."
12. **At end of Phase 3**, a single PR bumps to `0.3.0`, moves Unreleased →
    `[0.3.0]`, and gets tagged & released.

---

## Quick-reference cheatsheet

```sh
# Start a feature
git checkout main && git pull
git checkout -b feat/<phase>-<slug>

# Implement + test
# ...code...
npm run typecheck
npm test
npm run test:e2e        # if UI touched

# Review
# /code-review
# /security-review       # if security-sensitive

# CHANGELOG
# edit CHANGELOG.md → add a bullet under [Unreleased]

# Commit + open PR
git add -A
git commit -m "feat(<scope>): <short description>"
git push -u origin feat/<phase>-<slug>
# open PR on GitHub, fill the template

# After merge — at a release point:
git checkout main && git pull
git tag -a vX.Y.Z -m "Phase N — <theme>"
git push --follow-tags
# draft GitHub Release from CHANGELOG section
```
