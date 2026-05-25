# SmrtCash — Suggested next features

Drafted 2026-05-25 alongside the future-event-editing + GUI-restart work. Things that would fit naturally on top of what's now in place, ranked by how high I'd rate them if I were prioritizing.

## 1. Future-dated transactions (not just recurring changes)

You can now schedule "rent goes up to $2500 starting July 1." Logical next step: schedule a one-off transaction for a future date. Examples:

- "On July 15 I'll receive a $5,000 bonus."
- "On August 3 I'm paying for the vacation rental, $1,200."
- "I just paid the contractor's deposit but the cheque won't clear until next Friday — show it as pending."

The data model: add a `pending_transactions` table (or a `posted_at` nullable column on `transactions`). The cash-flow forecast (already in 0.18.0) becomes dramatically more useful because it can include both recurring projections AND specific known future events. On the posted-at date, the row auto-realizes the same way schedule changes promote into bills/income.

**Effort**: ~2 hours including UI. Reuses the promotion pattern from this commit.

## 2. End/archive a bill (vs delete)

Today: a bill goes away with `DELETE`, taking its history with it. That hurts long-tail analysis like "how much did I spend on Netflix in 2024?"

Add an `archived_at` timestamp + an "Archive" action that hides the bill from the active list but keeps it for reports. Combined with the schedule-changes audit trail from this commit, the operator can answer "show me everything I ever paid for streaming."

**Effort**: 1 hour. Schema, route, button. The reports side already joins to `bills` so a where-clause tweak is most of it.

## 3. 2FA / TOTP for super-admin and tenant-admin accounts

The security audit closed every P0/P1/P2. The next class of attack against a SaaS is credential reuse: an operator's password from another site shows up in a credential-stuffing list and someone walks in.

Add TOTP (RFC 6238) — operator scans a QR with Authenticator / 1Password / Bitwarden, supplies a 6-digit code on every login. Library: [@otplib/preset-default](https://www.npmjs.com/package/otplib). Schema: `users.totp_secret` (encrypted with the existing KEK) + `users.totp_enabled_at`. Backup codes too — 8 one-time recovery codes printed once.

Start with super-admin only (the highest-value target). Make it optional for tenant admins, encouraged for everyone. Per-tenant policy could require it.

**Effort**: ~6-8 hours including UI flow + recovery codes + audit log.

## 4. Push notifications via the PWA

The PWA already prompts to install. The next high-value feature: web-push for bill-due reminders + anomaly alerts. The /api/anomalies route already detects unusual spending; push notifications turn that signal into "you should look at this" instead of "you'll see it next time you open the app."

Library: `web-push` (Node side) + the browser's built-in Notification API. Per-user opt-in. Setting: `NOTIFY_BILLS_DUE_DAYS_AHEAD = 3` etc.

**Effort**: ~6 hours. Two-thirds of it is the consent + service-worker plumbing; the actual server-side "schedule a push for this user" is small.

## 5. Email-change flow (currently impossible)

The audit's F-19 finding said "no email-change endpoint exists" was the most secure stance. But it's also a UX dead-end — a user who switches employers and wants to move their account to a new email has to ask you to do it manually.

Add a proper two-step flow: user enters new email → confirmation token sent to the OLD email + the NEW email → both must click to confirm. The "must click old too" is the anti-ATO part. The audit's F-20 fix already requires `email_verified` for OIDC links; this is the same idea for local accounts.

**Effort**: ~3 hours. Reuses the verify-email infrastructure.

## 6. "Soft delete" for transactions

Today `DELETE FROM transactions` removes a row outright. If a user accidentally bulk-deletes 200 transactions, their only recovery is the daily backup (which loses everything that happened since).

Add a `deleted_at` column + a 30-day soft-delete window with an "Undo" action in the transactions list. The bulk-delete confirm modal mentions the recovery window.

The AI assistant already audit-logs its writes; reaching back through audit history to undo IS possible but operationally painful. A column-level soft-delete is the right primitive.

**Effort**: ~3 hours including index changes + query updates.

## 7. AI assistant: "dry-run" for write tools

The assistant's write tools (recategorize, set budget, update savings goal, etc.) take effect immediately. The audit log gives reversibility but the user has to know what to look for.

Add a `dryRun: true` parameter to every write tool. The assistant runs the query but doesn't commit; the result includes a "this would have changed N rows" message. The user clicks "Apply" or "Discard" in the UI. This makes the assistant feel more like a senior bookkeeper presenting work than a magic black box.

**Effort**: ~4 hours. Affects 11 write tools; mostly mechanical.

## 8. Currency conversion display on the dashboard

The multi-currency code is in. The dashboard rolls up multi-currency holdings + accounts via `display_currency`. But the UI doesn't always make the conversion visible — a $1,000 account in CAD shows as a USD-equivalent number with no indication of the source. Tooltip on hover, or a small "(CAD: 1357)" suffix, would help users trust the number.

**Effort**: 30 min. UI-only.

## 9. Customizable dashboard widgets

The dashboard layout is fixed today. Users want to reorder cards — "I care most about cash flow" vs "I care most about debt payoff." A drag-handle on each card + a per-user dashboard layout stored in `users.web_settings` (already exists as a JSON column for the idle-timeout) is enough.

**Effort**: ~4 hours. UX-heavy because drag-drop is fiddly.

## 10. Spending velocity alerts

Already detectable from the existing transaction history. "You spent 65% of your monthly Groceries budget by day 12 of the month." Surfaces on the dashboard or pushes a notification when crossed.

Builds on item #4 (push notifications) but isn't strictly dependent — could be an in-app banner first.

**Effort**: ~3 hours.

## My pick — the three I'd ship first

If I had eight hours to spend on user-visible improvements after today's work:

1. **#2 (Archive bills)** — 1 hour, makes today's schedule-changes feature properly historical
2. **#1 (Future-dated transactions)** — 2 hours, the natural extension of schedule changes into one-off events; makes cash-flow forecasting dramatically better
3. **#3 (2FA for super-admin)** — defense in depth at the highest-value account; closes the credential-stuffing window now that the rest of auth is tight

The combined ~10 hours produces three features each individually worth doing. After that, item #4 (push notifications) is the next big force-multiplier because it changes the app from a passive viewer to an active assistant.

## Deliberate non-recommendations

- **Adding a second financial-data provider** (MX, Yodlee, etc. alongside Plaid). The audit's F-23 SSRF work and F-17 Plaid token storage are correct. Adding a second provider doubles the surface for no clear customer win until Plaid coverage gaps become a real complaint.
- **Multi-currency wallet** (holding non-USD balances vs converted). Big lift, narrow audience.
- **Social features** (sharing budgets with non-household members, comments). Personal finance is a private product; resist this even when users ask.
- **Subscription consolidation suggestions** ("you have Netflix + Hulu + Disney — consider bundling"). Cute, but the AI assistant already lets you ask, and a hard-coded heuristic ages poorly.
