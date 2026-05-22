# Contributing to SmrtCash

Thanks for working on SmrtCash. This is a brief entry point — the full
process lives in [PROCESS.md](./PROCESS.md).

## Before you start

- Read [PROCESS.md](./PROCESS.md) for the 16-stage lifecycle, branching, and
  Definition of Ready / Done.
- Check the [Roadmap](./ROADMAP.md) — what phase are we in, what's planned.
- Make sure the test database setup runs locally (see
  [TESTING.md](./TESTING.md) and [INSTALLATION.md](./INSTALLATION.md)).

## Quick rules

1. **`main` is always green.** Never push to `main` directly except for the
   single release commit that bumps versions.
2. **Tests live in the same PR as production code.** Not a follow-up.
3. **Every PR adds a line to `CHANGELOG.md`** under `## [Unreleased]`.
4. **Conventional Commits** for messages — `feat(scope): …`,
   `fix(scope): …`, `docs(scope): …`. Scopes are listed in
   [PROCESS.md § 3 Stage 14](./PROCESS.md#stage-14--commit).
5. **Branch names:** `feat/<phase>-<slug>`, `fix/<slug>`, `hotfix/<slug>`,
   `chore/<slug>`.
6. **Squash-merge** feature branches.

## Reporting issues

Use the GitHub issue templates — bug report or feature request.

## Reviewing

Self-review every PR plus `/code-review`. Run `/security-review` if the
change touches auth, secrets, file upload, a third-party API, or the data
layer with user-supplied input.

## Releasing

See [PROCESS.md § 7 Release types](./PROCESS.md#7-release-types). The short
version:

- One phase = one minor version (`0.2.0` → `0.3.0`).
- Bug fixes between phases = patch (`0.2.0` → `0.2.1`).
- `1.0.0` arrives after Phase 5.
