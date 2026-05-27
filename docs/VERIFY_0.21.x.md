# SmrtCash 0.21.x verification guide

A one-time walk-through to confirm each 0.21.x slice does what its
roadmap entry promised. Set-up, click path, expected outcome.
Each section is independent — work through them in any order.

**Prereqs:** local stack running on `http://localhost`, signed in as
a tenant admin, at least one account with a handful of
transactions. Hard-refresh after the deploy so the new SW cache
takes over. If something looks stuck on an old icon / page,
DevTools → Application → Storage → Clear site data.

---

## 0.21.0 — Real tax export (Schedule C, mileage, TXF)

### What to expect on the UI

- Sidebar **Insights** group now lists **Mileage** between **Tax** and
  **Anomalies**.
- `/tax` page shows two tabs: **Summary** (unchanged from before) and
  **Schedule C** (new). Three download buttons in the header:
  **Download CSV**, **Download TXF**, **Mileage CSV**.

### Setup

1. On the **Categories** page, pick (or create) a category and set
   its **Tax category** to a Schedule C–style label, e.g.
   `Schedule C - Line 8 Advertising` or just `advertising`. Repeat
   for at least two categories — one expense, one income (line
   1 / "gross receipts").
2. Add a few transactions in those categories within the current
   tax year.

### Mileage log

1. Click **Mileage** in the sidebar.
2. Click **Add trip** → fill date, **purpose = business**, miles
   = `25.4`, optional locations + vehicle. Save.
3. Confirm the trip lands in the **Trips in {year}** table.
4. The summary cards at top should show:
   - **Total miles** = 25.4
   - **Estimated deduction** = `25.4 × 0.70 = $17.78` (2026 rate)
   - **Business rate** = `70.0¢/mi`
5. Click **Download CSV** — file `smrtcash-mileage-{year}.csv`
   downloads with date / purpose / miles columns.

### Schedule C view

1. Go to **/tax** → click the **Schedule C** tab.
2. Verify:
   - Each tagged tax_category appears under the right Schedule C
     line (matched by exact line label, "Schedule C - Line N"
     prefix, or keyword like "advertising").
   - Line 9 (**Car and truck**) shows the auto-added mileage
     deduction with `IRS standard mileage (auto)` in its
     "Source tax_category labels" column.
   - **Gross receipts**, **Total expenses**, and **Net profit**
     cards add up.
3. If any tax_category labels weren't recognised, you'll see an
   amber banner listing the unmatched labels. Rename them on
   the Categories page to a line-aware label and re-load.

### TurboTax TXF export

1. Click **Download TXF** in the header.
2. Open `smrtcash-tax-{year}.txf` in a text editor. First 4 lines
   should be:
   ```
   V042
   ASmrtCash
   D{MM/DD/YYYY}
   ^
   ```
3. Each subsequent block has TD / N{code} / C1 / L1 / ${amount} /
   P{description} / ^. Codes are 524 (advertising), 525 (car +
   truck), 535 (office expense), 593 (gross receipts), etc.
4. (Optional) Import the file into TurboTax → File → Import →
   From Accounting Software → TXF. Confirm the lines map to the
   expected Schedule C entries. Numbers should match the on-screen
   totals on the Schedule C tab.

---

## 0.21.1 — Refund / chargeback tracking

### Setup
Open **/transactions** with at least a few rows visible.

### Click path

1. On any transaction row, click the **↩** icon in the actions
   column.
2. The **Track refund / chargeback** modal opens.
3. Set **Status** → `Refund pending`, add a note like "Filed claim
   2026-06-01", save.
4. The row's description column now shows an orange pill `↩ Refund
   pending`.
5. Click that pill → modal re-opens with the saved values
   pre-filled.
6. Change status to `Refunded`, save. Pill turns green.
7. Set status back to `— Clear / no refund —` and save → pill
   disappears.

### What to verify

- The pill colour matches the state (warn = pending/disputed,
  pos = refunded, neg = empty when set to none).
- `refund_updated_at` increments on every state change (visible
  in the modal footer "Last updated …").
- Reloading the page preserves the state — confirms server round-
  trip.

---

## 0.21.2 — Warranty tracking

### What to expect

- Sidebar **Tools** group now has **Warranties** below
  **Routes**.

### Click path

1. Sidebar → **Warranties**.
2. Click **Add warranty** → item `Test laptop`, vendor `Acme`,
   purchase date today, covered until 14 days from today, price
   `$1,200`, save.
3. Status pill on the new row should be `Expiring soon` (because
   covered-until is within 30 days).
4. Switch the filter dropdown to **Expiring < 30 days** → only
   this row remains.
5. Filter **Expired** → empty list.
6. **Edit** the row, set covered-until to 180 days from today,
   save → pill flips to `Active`.

### Daily insight card (best-effort)

Run the dev insights generator to confirm the warranty card fires
(or wait until the next scheduled run). When a warranty is ≤ 30
days from expiry, an insight card titled
`Warranty ending soon: {item}` should appear on the dashboard at
the next /api/insights/cards fetch.

---

## 0.21.3 — Non-traditional household models

### What to expect

- Sidebar **Household** group has a new **Participants** item.

### Click path

1. Sidebar → **Participants**.
2. Add two participants: name `Spouse A`, kind `Spouse`; name
   `Spouse B`, kind `Spouse`. Optional colors help the rollup
   table read at a glance.
3. **Account splits** section → pick a shared account, click
   **Edit** → set both spouses at 50% each. Sum indicator should
   show **100.00%**. Try a 60 / 50 split → save fails with a
   `must sum to 100` banner. Fix and save.
4. **Custody periods** section → click **Add custody period** →
   pick an account, owner `Spouse A`, start = first of the month,
   end = today. Save.
5. **This year — per-participant rollup** at the bottom should
   show non-zero numbers for both spouses if they have shared
   transactions in the window. Custody-period transactions show
   up 100% under Spouse A even though the account is on a 50/50
   split.

### Edge cases worth poking

- Deleting a participant that's referenced by a split or custody
  period: the FK cascade removes the dependent row.
- Setting all splits empty (delete all rows) → the account
  reverts to "default tenant ownership"; rollup excludes it.

---

## 0.21.4 — Investment performance (TWRR / IRR / vs S&P 500)

### Prereqs

At least one account whose **type** is `investment`, with one or
more holdings populated. The page shows performance over the past
year by default.

### Click path

1. **/investments** → new top section **Performance**.
2. Confirm the four headline cards:
   - **TWRR (annualized)** — time-weighted return, strips out
     cash-flow timing.
   - **IRR (annualized)** — money-weighted return.
   - **Benchmark (S&P 500)** — annualized for the same window
     from the built-in yearly table.
   - **vs Benchmark** — TWRR − benchmark; pos / neg colored.
3. Per-account table below lists each investment account's start
   value, end value, TWRR, IRR, and per-account "vs S&P 500"
   delta.
4. Change the date range to a custom window (e.g. last 3 months)
   and click **Reload**. Numbers should annualize correctly for
   the shorter window.

### Known precision caveats

- Beginning-of-period value is approximated from cumulative prior-
  balance transactions. Precise historical TWRR needs daily
  holdings snapshots (follow-up work).
- Benchmark uses a hard-coded yearly S&P 500 total-return table
  (`server/src/domain/investment-performance.ts`). Pass
  `?benchmarkRate=0.07` on the URL to override with a fixed rate.

---

## 0.21.5 — Scenario cash-flow forecasting

### What to expect

- Sidebar **Planning** group gains **Scenarios** below **Debt
  payoff**.

### Click path

1. Sidebar → **Scenarios**.
2. **Controls** card: leave horizon at 6 months. Drag **Income**
   slider to 110%, drag **Expenses** to 90%.
3. Click **+ Add one-time event** → pick a date 60 days out,
   `Income`, `5000`. Click **Run scenario**.
4. The chart at the bottom plots two lines:
   - Grey **Baseline** — your real recurring income + bills.
   - Indigo **Scenario** — same but with the 10% income bump,
     10% expense cut, and the $5,000 spike.
5. The three metric cards above the chart should show:
   - Starting cash (same in both)
   - Baseline ending (unchanged from /api/cash-flow)
   - Scenario ending (higher than baseline given the positive
     adjustments)
6. Drop the income slider to 70% and the scenario line should
   visibly dip below the baseline by the end of the horizon.

---

## 0.21.6 — Manual cancellation queue (NO automation)

### What to expect

- Sidebar **Planning** group gains **Cancel queue** below
  **Subscriptions**.

### Click path

1. Sidebar → **Cancel queue**.
2. **Add to queue** → service name `Disney+`, cancel URL
   `https://www.disneyplus.com/account` (or any URL), monthly
   `$13.99`. Save.
3. Status pill on the row reads `Queued`. Click **→ In progress**
   → pill turns amber, `last_attempt_at` stamped.
4. Click the **Open** link in the Cancel URL column → new tab
   opens to the vendor (we never hit the vendor server-side).
5. Once you've worked through the vendor's own cancel flow,
   click **→ Cancelled** → pill turns green, `completed_at`
   stamped.
6. Top summary card **Monthly savings** sums `monthly_cents` of
   every `done` row.

### What it deliberately doesn't do

- No stored vendor credentials.
- No outbound HTTP requests on your behalf.
- No Playwright / headless browser automation.

If you queue something and bail out, mark it **Abandoned** rather
than deleting — the row is useful for "things I considered
cancelling".

---

## 0.21.7 — Portable .smrtcash data export + importer

### Export

1. Sidebar → **Workspace** (or `/workspace`).
2. **Data portability** section → click **Export all my data**.
3. A `.smrtcash` file (gzipped tar under the hood) downloads. The
   info banner reports per-table counts.
4. Tarball can be inspected:
   ```
   tar -tzf smrtcash-….smrtcash | head -10
   ```
   You should see `…/tenant.json` and `…/attachments/<id>-….{ext}`
   entries.

### Round-trip import

1. Create a second, EMPTY tenant (Workspace → tenant switcher).
2. Switch into the empty tenant.
3. Workspace → **Import a .smrtcash bundle** → pick the file you
   just downloaded.
4. Confirmation prompt appears; click OK.
5. The result banner shows
   `Imported N categories, N accounts, N transactions` with the
   skipped tables listed.
6. Browse `/accounts` and `/transactions` in the empty tenant —
   they should now contain the imported data (no attachment file
   bodies — that's a known follow-up).

### Edge cases

- Importing into a non-empty tenant works but doesn't dedupe —
  expect duplicates. Use a fresh tenant for clean rehydration.
- The importer rejects bundles with `schema_version !== 1`.
- Errors during transaction insert (e.g. FK to a missing
  category) are surfaced in `errors` on the response, the import
  continues for everything else.

---

## Common gotchas

- **Old icon / old code after deploy** — service worker is still
  controlling the page. DevTools → Application → Service Workers
  → Unregister. From 0.20.x onward the SW cache rotates per
  release via `__APP_VERSION__` substitution, so this only bites
  the first reload after a prior-build session.
- **Migrations fail to apply** — Postgres rejects `CURRENT_DATE`
  in an index `WHERE` clause (must be IMMUTABLE). If you wrote a
  new partial index that uses `CURRENT_DATE` or `now()`, drop
  the predicate or put the date into a generated column.
- **Tax export shows nothing** — check at least one category has
  a non-NULL `tax_category` value and at least one transaction
  references that category inside the requested year. Transfers
  (rows with `transfer_group_id NOT NULL`) are deliberately
  excluded.
