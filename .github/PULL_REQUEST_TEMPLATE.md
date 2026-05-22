<!--
Thanks for the PR! The checklist below is SmrtCash's Definition of Done.
Open the PR even with unchecked boxes — but everything must be ticked
before merge. See docs/PROCESS.md for details.
-->

## Summary

<!-- One paragraph: what changes and why. -->

## What changed

<!-- Bullet list of concrete changes. Include API endpoints, schema changes,
     env vars added/changed, default behavior shifts. -->

## How it was tested

<!-- Which test layers got new tests? Manual steps you ran? -->

## Screenshots / demo

<!-- For UI changes — paste a screenshot or short clip. Delete if not UI. -->

## Breaking changes

<!-- None / list of anything operators need to know. Delete if none. -->

## Linked phase

<!-- e.g. Phase 3 — Receipts & Attachments. Add a roadmap link if relevant. -->

---

## Definition of Done

- [ ] Acceptance criteria are met
- [ ] Tests cover the change at the lowest meaningful layer
- [ ] `npm run typecheck` clean (server + web)
- [ ] `npm test` clean (server + web)
- [ ] `npm run test:e2e` clean (if UI changed)
- [ ] `docs/FEATURES.md`, `docs/ROADMAP.md`, `docs/KNOWN_ISSUES.md` updated as applicable
- [ ] `CHANGELOG.md` entry added under `## [Unreleased]`
- [ ] Self-review + `/code-review` complete; findings addressed
- [ ] `/security-review` run **if** this change touches auth, secrets, file
      upload, a third-party API, or the data layer with user-supplied input
- [ ] Conventional Commit message: `feat|fix|docs|test|refactor|chore(scope): …`
- [ ] Squash-merge (not merge-commit) when this PR is approved
