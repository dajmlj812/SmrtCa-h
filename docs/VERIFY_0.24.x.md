# SmrtCash 0.24.x verification guide

A walk-through to confirm each 0.22.x + 0.24.x slice does what its
roadmap entry promised. Use this before tagging RC1 or after any
significant deploy. Each section is independent — work through them
in any order.

**Prereqs:** stack running, signed in as a tenant admin, at least
one account with several months of transactions including some
recurring bills (Netflix, electric, etc.). Hard-refresh after the
deploy so the new SW cache takes over. If something looks stuck,
DevTools → Application → Storage → Clear site data.

---

## 0.22.0 — Bill matching engine + `/recurring`

### Sidebar consolidation

1. Sidebar shows a single **Recurring** entry under Planning (no
   separate Bills / Subscriptions).
2. Open `/bills` directly → redirects to `/recurring`.
3. Open `/subscriptions` → redirects to `/recurring?view=subscriptions`.
4. The Subscriptions tab on `/recurring` lights up when you click it.

### Auto-match — confident case

1. Pick an existing bill, e.g. `Netflix` with `next_due_date` ≈ today
   and `amount_cents = 1549`.
2. Open the bill's **Auto-match** action — confirm:
   - Mode = **Fixed**, Merchant pattern = `Netflix`, Window = **7
     days**, Grace = **3 days**.
3. Import (or manually add) a transaction with raw_description
   "NETFLIX.COM" dated within ±7 days, amount $-15.49.
4. Refresh `/recurring`. The triage queue at the top should be empty.
5. In `/transactions`, the new row should:
   - Have its category set to the bill's category (if it was blank).
   - Show in any "bill payments" view as linked.
6. Click into the bill on `/recurring` → its `next_due_date` should
   have advanced by one cycle.

### Triage — ambiguous vendor

1. Duplicate the Netflix bill (Duplicate action) so you have two
   bills with merchant_pattern=`Netflix`, both monthly, near today's date.
2. Add a transaction that matches both: "NETFLIX.COM", $-15.49.
3. `/recurring` — triage card appears at the top with **both** candidates
   listed under one transaction group ("2 candidate bills").
4. Click **Accept** on the right one → its sibling row auto-closes as
   `reassigned`. Bill flips to paid for that period.

### Triage — out-of-tolerance amount

1. With a Fixed-mode bill expecting $15.49, drop a $5.00 transaction
   from "NETFLIX.COM" dated within window.
2. Triage row lands with reason **Amount is outside the bill's
   expected band**.
3. Accept it anyway → the transaction links (user-overridden).
4. Or Reject it → triage row closes, no link.

### Overdue sweep

1. Pick a bill whose `next_due_date` is more than `overdue_grace_days`
   ago, with no matching payment recorded.
2. Open `/recurring` → click **Sweep overdue** in the toolbar.
3. Banner reports `flipped 1` (or however many).
4. Dashboard insight cards show a `bill_overdue` card per flipped bill.

---

## 0.22.1 — Bill row actions + `/recurring` toolbar

### Auto-match config modal

1. From any bill row on `/recurring`, click **Auto-match**.
2. Modal opens with: Merchant pattern (text), Amount mode (Fixed /
   Drifts / Variable), Match window (±days), Overdue grace (days).
3. Variable mode shows an extra **Absolute cap ($)** field; it's
   hidden for Fixed and Drift.
4. Help text under "Amount mode" updates as you switch modes.
5. Save → row reloads with the new config; bill card shows the
   updated state.

### Pause / Unpause

1. Click **Pause** on an active bill. Modal asks for a resume date
   (defaults to 30 days out). Save.
2. Bill's Status pill shows "Paused until \<date\>". The matcher will
   skip it.
3. **Unpause** appears in place of Pause. Click it → status returns
   to Active immediately.

### Skip period

1. Click **Skip period** on a non-paused bill.
2. Confirm dialog explains: marks current period as skipped and
   advances next due date.
3. After confirm, `next_due_date` advances by one cycle.
4. In bill history (`/api/bills/:id/periods`), the skipped period has
   `status = 'skipped'` and a `skipped_at` timestamp.

### Rescan + Sweep buttons

1. **Rescan transactions** — toolbar at top of `/recurring`. Click →
   banner reports `Rescanned N transactions — M auto-matched, K sent to
   triage.` Useful after editing a bill's merchant pattern.
2. **Sweep overdue** — same toolbar. Returns `Flipped N past-due
   bills to overdue.` or "No bills past due grace window."

---

## 0.22.2 — Credit-card payoff goals

### Set credit limits

1. `/accounts` → open a credit-card account. The detail view shows a
   **Credit limit** kv-item. Click **Set limit** → enter $5,000 →
   Save. Confirm utilization shows `<owed>/$5,000 = N%`.
2. (Alternative path) `/debt-payoff` table — the **Credit limit**
   column is inline-editable for credit_card rows.

### Build a payoff goal

1. Click **💳 Credit card payoff** on `/goals` (or **💳 Create payoff
   goal** on `/debt-payoff`).
2. Multi-select two credit cards. Modal shows:
   - Total balance
   - Total credit limit
   - Current utilization %
3. Pick **Pay to 30% utilization**. Target balance + amount to pay
   down compute live. Confirm the math: `target = total_limit × 0.30`.
4. Optional target date.
5. Click **Create payoff goal**.

### Goal card display

1. Back on `/goals`. The new payoff goal card:
   - Shows a **Payoff** pill next to the name.
   - Displays "Balance: $X · target $Y".
   - Progress bar fills as the balance drops (not as a contribution
     grows).
   - Footer shows "N% paid down · $X to go".
   - Bottom note: "Linked to N credit cards · updates live from
     balances".
   - **No Contribute button** (intentionally — payoff goals
     auto-track from accounts).

### Live update

1. Add a $200 payment transaction against one of the linked cards.
2. Refresh `/goals` → the goal's displayed balance dropped by $200,
   progress bar advanced accordingly.

---

## 0.24.0 — `/scenarios` hub

### Picker UI

1. Open `/scenarios`. Left rail shows a picker grouped by category
   (Cash flow, Wealth building, Debt payoff, Life events). Each entry
   has an icon + title.
2. Clicking a scenario routes to `?type=<id>` in the URL.
3. Hit reload → the same scenario loads.
4. Per-scenario inputs persist when switching between scenarios:
   - Set the Invest scenario's monthly contribution to $1000.
   - Switch to FIRE → set spend to $80k.
   - Switch back to Invest → your $1000 is still there.

### Cash-flow stress test (migration of the old `/scenarios`)

1. Pick **Cash-flow stress test**. Form: horizon dropdown, income
   slider, expense slider, one-time events.
2. Set income to 110% and expenses to 90%. Click **Run** (or it
   auto-runs).
3. Two-line chart appears: Baseline (grey) + Scenario (purple).
4. Cards show Starting / Baseline ending / Scenario ending.

---

## 0.24.1 — Wealth scenarios

For each below, fill in reasonable values and confirm the result panel
shows the listed metrics.

### Invest $X/mo for Y years at Z%

- 3 metric cards: Total contributed / Tax-deferred ending / Taxable ending.
- Growth-curve chart with three series (Contributed, Tax-deferred, Taxable).

### Bump 401(k) to N%

- 3 metric cards: Annual contribution change / Take-home hit
  (after tax savings) / Tax savings this year.
- 3 metric cards underneath: Balance at retirement (current vs new)
  with the difference highlighted.
- A "leaving free money on the table" warning when the new
  contribution % is below the employer match cap.

### Windfall split

- Three metric cards (Emergency fund / Toward debt / Invested) with
  the cumulative N-year impact in the description.
- If splits don't total 100%, a warning banner shows the total.

### FIRE date

- Annual savings + save rate
- FIRE number = annual spend / SWR
- Distance to FIRE
- "Years to FIRE" big number (or a clear "spending exceeds take-home"
  banner when savings ≤ 0).

---

## 0.24.2 — Debt scenarios

### Add $X/mo extra payment

- Current trajectory card (payoff time, total interest) vs With
  extra card (payoff time, total interest).
- Net impact card: time saved + interest saved.
- If payment doesn't cover interest, banner explains the minimum
  needed.

### Balance transfer offer

- Two side-by-side cards: stay vs transfer.
- Transfer card includes the fee + remaining balance at promo end if
  payoff doesn't fit.
- Verdict card: interest saved (or lost) by transferring.

### Consolidate at one rate

- Add/remove multi-debt rows.
- Verdict shows interest saved + monthly payment change (color-coded).

### Biweekly mortgage

- Standard vs biweekly side-by-side.
- Net impact: time saved + interest saved (typically years and
  thousands).

---

## 0.24.3 — Life-event scenarios

### Have a kid

- Monthly cost added + annual net (after tax credit).
- Cumulative cost: Year 1 / Years 1–5 / Years 1–18.
- 529 ending value at 18.

### Buy a house

- Cash at closing, loan amount, monthly PITI + HOA + PMI breakdown
  table.
- Front-end + back-end DTI ratios with color tone.
- Verdict banner: Comfortable / Stretched / Over budget.

### Job change

- Current vs new total comp; new (COL-adjusted) total.
- Annual delta (color-tone signaling raise vs cut).
- N-year net: cumulative comp delta compounded + relocation cost
  subtracted.

### Sabbatical / income loss

- Monthly burn during break, runway at burn rate.
- Cash at end of break (success → remaining cushion; failure → red
  banner with breakpoint month).
- Rebuild path (when surviving): time to restore starting cushion.

### Recession / income shock

- Baseline vs shocked monthly net.
- End-of-shock cash position with success / stretched / over banners.

---

## 0.24.4 — 11 new reports

`/reports` should list **17 reports** in the left rail. Confirm each
new one runs without error and the CSV export downloads:

- [ ] Year-over-year by category
- [ ] Month-over-month movers
- [ ] Day-of-week spending pattern
- [ ] Tax-deductible YTD
- [ ] Savings rate by month
- [ ] Income sources breakdown
- [ ] First-time merchants
- [ ] Refunds and chargebacks YTD
- [ ] Bill price drift
- [ ] Debt balance by month
- [ ] Average transaction by category

**Nav-loop fix**: after running any report, click a sidebar link →
should navigate immediately (no 2-click workaround needed).

---

## 0.24.5 — Editable mileage rates

1. Open `/mileage`. Below the year summary table, a new section: **IRS
   standard mileage rates**.
2. Confirm the table lists every year currently seeded (2022–2026 by
   default) with Business / Charity / Medical rates.
3. Click **Edit** on any row → values become inputs → Save → row
   updates, source pill flips from `seeded` to `manual`.
4. Click **+ Add year** → enter `2027` → row appears pre-filled from
   the most recent year on file.
5. Run the **Tax-deductible YTD** report (from 0.24.4) and confirm
   the deduction uses the new rates if you edited the current year.

---

## 0.24.6 — Daily anomaly scan

1. Confirm **ANOMALY_ENABLED** is `true` in `/system/settings`.
2. Make sure the tenant has at least one obvious anomaly candidate
   (e.g. a $2,000 charge at a merchant you usually spend $20 at,
   already on file).
3. Within ~1 hour of the next scheduler tick (or immediately after
   restarting the app), `/anomalies` shows the alert.
4. Re-running the scheduler doesn't create duplicates (anomaly_alerts
   has a unique index on (transaction_id, kind)).

---

## 0.24.7 / 0.24.8 — Dark-mode polish

1. Toggle to dark theme (ThemeToggle in the sidebar footer).
2. Open any page with a date input (e.g. `/transactions` filter,
   `/goals` new-goal modal, `/mileage` add-trip form). The calendar
   icon next to the date input should be clearly visible (light
   stroke on dark background). Hover shows an accent-tinted
   background.
3. Bare `.pill` elements (e.g. category pills on `/transactions`)
   show against the surface-3 tint, not the old hardcoded light blue.
4. Status pills on `/recurring` (Active / Paused / Closed) all read
   cleanly.

---

## 0.24.9 — Portability export

1. `/workspace` → **Download .smrtcash archive**.
2. File downloads as `smrtcash-<tenant>-<timestamp>.smrtcash`.
3. Open it (it's a gzipped tar): inside is `tenant.json` (manifest +
   bundled rows) and `attachments/` (any receipts you've uploaded).
4. Re-import the archive on a fresh tenant (or a test instance) →
   counts in the manifest match what lands.

---

## 0.24.10 — Auto-learn manual renames + drift-mode amount snap

### Manual rename auto-rule

1. Find a transaction with a messy raw_description like `POS DEBIT
   12/05 STARBUCKS #4523 SEATTLE WA`.
2. Click the row → edit merchant to `Starbucks`. Save.
3. Open `/normalization-rules`. A new rule appears with:
   - Pattern = the full raw_description
   - Normalized merchant = `Starbucks`
   - Source = `manual`
   - Enabled = true
4. Run the next import containing a similar description → the rename
   carries forward via the new rule.
5. (Optional) Edit the rule's pattern to just `STARBUCKS` to
   generalize.

### Drift-mode amount snap

1. Create a bill: name `Mister Car Wash`, amount $24.99, frequency
   monthly, **Amount mode = Drifts**, merchant pattern `Mister Car
   Wash`.
2. Import a transaction matching that bill at $26.99.
3. Refresh `/recurring`. The bill's expected amount has snapped to
   $26.99. Next cycle's budget reflects the new expected.
4. Repeat with a **Fixed-mode** bill at $15.49 + a $15.49 charge →
   amount stays $15.49 (fixed-mode is "alert me if it changes,"
   so we do NOT auto-update).

---

## Sign-off

After all sections pass, the build is RC1-ready. Tag the release and
move on to the RC1 cohort distribution / feedback collection plan.
