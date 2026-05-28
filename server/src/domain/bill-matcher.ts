/**
 * 0.22.0 — Bill matching engine.
 *
 * Given a freshly imported (or manually added) transaction, find
 * the bill it pays — if any — and either:
 *   • auto-link it (write a bill_periods row with status='paid',
 *     advance the bill's next_due_date, fill the transaction's
 *     category if blank), or
 *   • queue it for human review in bill_match_triage when the
 *     engine isn't confident enough to act.
 *
 * Decision summary (Derek's spec):
 *
 *   Amount fit per bills.amount_mode:
 *     fixed    — ±max($1, 2% of expected)
 *     drift    — trailing 3-month average ±10%, falls back to
 *                expected ±10% until 3 cycles of history exist
 *     variable — any amount ≤ amount_tolerance_cents (absolute cap)
 *
 *   Date fit — txn_date within ±match_window_days of next_due_date.
 *
 *   Vendor fit — case-insensitive substring match between
 *     bills.merchant_pattern and transactions.raw_description (or
 *     normalized_merchant). Bills with NULL merchant_pattern are
 *     skipped (matching is disabled for them).
 *
 *   Triage triggers (any one):
 *     • 2+ candidate bills match the same transaction
 *     • amount fits but in the outer 25% of its allowed band
 *     • date fits but in the outer 25% of the window
 *
 *   Single confident match → auto-link.
 *
 * Overage handling: only the FIRST matching transaction in a period
 * links to the bill. Subsequent same-vendor charges in the same
 * period are left as ordinary transactions (they'll show up in the
 * bill's category but are not bill payments).
 *
 * Pause: bills with paused_until >= today are skipped entirely.
 */

import type pg from 'pg';
import { query, withTransaction } from '../db/pool.js';
import { advanceByFrequency } from '../routes/bills.js';

type PoolClient = pg.PoolClient;

const EDGE_OUTER_PCT = 0.25; // outer 25% of tolerance = edge / triage trigger

// ── Types ────────────────────────────────────────────────────────

type Mode = 'fixed' | 'drift' | 'variable';
type Frequency = 'monthly' | 'weekly' | 'biweekly' | 'yearly' | 'one-time';

interface BillRow {
  id: string;
  tenant_id: string;
  name: string;
  amount_cents: number; // > 0, the magnitude expected on the txn
  frequency: Frequency;
  next_due_date: string; // YYYY-MM-DD
  category_id: string | null;
  active: boolean;
  amount_mode: Mode;
  amount_tolerance_cents: number | null;
  match_window_days: number;
  merchant_pattern: string | null;
  paused_until: string | null;
  overdue_grace_days: number;
}

interface TxnRow {
  id: string;
  tenant_id: string;
  account_id: string;
  txn_date: string; // YYYY-MM-DD
  amount_cents: number; // signed (negative for debits)
  raw_description: string;
  normalized_merchant: string | null;
  category_id: string | null;
}

interface ScoredCandidate {
  bill: BillRow;
  /** 0..1; 1 = exact match, 0 = at the very edge of acceptable. */
  amount_fit: number;
  date_fit: number;
  /** True when amount or date is in the outer 25% of its tolerance. */
  edge: boolean;
  edge_reason: 'amount_edge' | 'date_edge' | null;
}

// ── Helpers ──────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

function lc(s: string | null | undefined): string {
  return (s ?? '').toLowerCase();
}

/**
 * Trailing-3-cycle average of matched payments for a bill, in cents.
 * Returns null if fewer than 3 historical matches exist (caller falls
 * back to bills.amount_cents in that case).
 */
async function trailingDriftAverage(
  billId: string,
  client?: PoolClient,
): Promise<number | null> {
  const sql = `
    SELECT ABS(t.amount_cents) AS amt
      FROM bill_periods bp
      JOIN transactions t ON t.id = bp.matched_txn_id
     WHERE bp.bill_id = $1
       AND bp.status = 'paid'
       AND bp.matched_txn_id IS NOT NULL
     ORDER BY bp.period_anchor_date DESC
     LIMIT 3
  `;
  const r = client
    ? await client.query<{ amt: string }>(sql, [billId])
    : await query<{ amt: string }>(sql, [billId]);
  if (r.rows.length < 3) return null;
  const total = r.rows.reduce((s, row) => s + Number(row.amt), 0);
  return Math.round(total / r.rows.length);
}

/** Returns null when amount is outside the allowed band. */
async function scoreAmount(
  bill: BillRow,
  txnAbs: number,
  client?: PoolClient,
): Promise<{ fit: number; edge: boolean } | null> {
  if (bill.amount_mode === 'fixed') {
    const expected = bill.amount_cents;
    const tol = Math.max(100, Math.round(expected * 0.02)); // ±max($1, 2%)
    const delta = Math.abs(txnAbs - expected);
    if (delta > tol) return null;
    const fit = 1 - delta / tol;
    return { fit, edge: fit < EDGE_OUTER_PCT };
  }
  if (bill.amount_mode === 'drift') {
    const baseline =
      (await trailingDriftAverage(bill.id, client)) ?? bill.amount_cents;
    const tol = Math.round(baseline * 0.1); // ±10%
    if (tol === 0) return null;
    const delta = Math.abs(txnAbs - baseline);
    if (delta > tol) return null;
    const fit = 1 - delta / tol;
    return { fit, edge: fit < EDGE_OUTER_PCT };
  }
  // variable: any amount ≤ amount_tolerance_cents (absolute cap)
  const cap = bill.amount_tolerance_cents ?? 0;
  if (cap <= 0) return null;
  if (txnAbs > cap) return null;
  // Closer to expected = higher fit; charge that maxes out the cap is
  // edge-zone (suggests something abnormal).
  const fit = 1 - txnAbs / cap;
  return { fit, edge: fit < EDGE_OUTER_PCT };
}

function scoreDate(
  bill: BillRow,
  txnDate: string,
): { fit: number; edge: boolean } | null {
  const days = Math.abs(daysBetween(bill.next_due_date, txnDate));
  if (days > bill.match_window_days) return null;
  const fit = 1 - days / bill.match_window_days;
  return { fit, edge: fit < EDGE_OUTER_PCT };
}

function vendorMatches(bill: BillRow, txn: TxnRow): boolean {
  if (!bill.merchant_pattern) return false;
  const needle = lc(bill.merchant_pattern);
  return (
    lc(txn.raw_description).includes(needle) ||
    lc(txn.normalized_merchant).includes(needle)
  );
}

// ── Core: try to match one transaction ───────────────────────────

export interface MatchOutcome {
  matched_bill_id: string | null;
  triaged: number;
}

export async function tryMatchTransaction(
  txnId: string,
): Promise<MatchOutcome> {
  return withTransaction(async (client) => {
    const txnRes = await client.query<TxnRow>(
      `SELECT t.id, a.tenant_id, t.account_id, t.txn_date,
              t.amount_cents, t.raw_description, t.normalized_merchant,
              t.category_id
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.id = $1`,
      [txnId],
    );
    if (txnRes.rows.length === 0) return { matched_bill_id: null, triaged: 0 };
    const txn = txnRes.rows[0]!;
    // Bills are expenses: txn must be a debit (negative). Income/transfer
    // signs would never match a bill anyway.
    if (txn.amount_cents >= 0) return { matched_bill_id: null, triaged: 0 };

    // Already matched? Don't re-process.
    const already = await client.query(
      `SELECT 1 FROM bill_periods WHERE matched_txn_id = $1 LIMIT 1`,
      [txn.id],
    );
    if (already.rows.length > 0) return { matched_bill_id: null, triaged: 0 };

    // Pull active, unpaused bills with a merchant_pattern.
    const billsRes = await client.query<BillRow>(
      `SELECT id, tenant_id, name, amount_cents, frequency, next_due_date,
              category_id, active, amount_mode, amount_tolerance_cents,
              match_window_days, merchant_pattern, paused_until,
              overdue_grace_days
         FROM bills
        WHERE tenant_id = $1
          AND active = true
          AND merchant_pattern IS NOT NULL
          AND (paused_until IS NULL OR paused_until < $2)`,
      [txn.tenant_id, txn.txn_date],
    );

    const txnAbs = Math.abs(Number(txn.amount_cents));
    const candidates: ScoredCandidate[] = [];

    for (const bill of billsRes.rows) {
      if (!vendorMatches(bill, txn)) continue;
      const ds = scoreDate(bill, txn.txn_date);
      if (!ds) continue;
      const as = await scoreAmount(bill, txnAbs, client);
      if (!as) {
        // Vendor + date matched but amount didn't — surface as triage
        // (out_of_tolerance) so user can confirm/reject.
        await insertTriage(
          client,
          txn.tenant_id,
          bill.id,
          txn.id,
          'out_of_tolerance',
          null,
          ds.fit,
        );
        continue;
      }
      candidates.push({
        bill,
        amount_fit: as.fit,
        date_fit: ds.fit,
        edge: as.edge || ds.edge,
        edge_reason: as.edge ? 'amount_edge' : ds.edge ? 'date_edge' : null,
      });
    }

    if (candidates.length === 0) return { matched_bill_id: null, triaged: 0 };

    // Ambiguous: more than one candidate. Triage all of them, no auto.
    if (candidates.length > 1) {
      for (const c of candidates) {
        await insertTriage(
          client,
          txn.tenant_id,
          c.bill.id,
          txn.id,
          'ambiguous_vendor',
          c.amount_fit,
          c.date_fit,
        );
      }
      return { matched_bill_id: null, triaged: candidates.length };
    }

    // Exactly one candidate. If edge-zone, triage; otherwise auto-link.
    const only = candidates[0]!;
    if (only.edge) {
      await insertTriage(
        client,
        txn.tenant_id,
        only.bill.id,
        txn.id,
        only.edge_reason ?? 'amount_edge',
        only.amount_fit,
        only.date_fit,
      );
      return { matched_bill_id: null, triaged: 1 };
    }

    await linkBillToTxn(client, only.bill, txn);
    return { matched_bill_id: only.bill.id, triaged: 0 };
  });
}

async function insertTriage(
  client: PoolClient,
  tenantId: string,
  billId: string,
  txnId: string,
  reason: 'ambiguous_vendor' | 'amount_edge' | 'date_edge' | 'out_of_tolerance',
  amountFit: number | null,
  dateFit: number,
): Promise<void> {
  await client.query(
    `INSERT INTO bill_match_triage
       (tenant_id, bill_id, transaction_id, reason, amount_fit, date_fit)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (bill_id, transaction_id) DO NOTHING`,
    [tenantId, billId, txnId, reason, amountFit, dateFit],
  );
}

/**
 * Apply a confident match: insert bill_periods row (status='paid'),
 * advance the bill's next_due_date, and adopt the bill's category
 * onto the transaction if the transaction was uncategorized.
 */
async function linkBillToTxn(
  client: PoolClient,
  bill: BillRow,
  txn: TxnRow,
): Promise<void> {
  await client.query(
    `INSERT INTO bill_periods
       (bill_id, period_anchor_date, tenant_id, status,
        matched_txn_id, marked_paid_at)
     VALUES ($1, $2, $3, 'paid', $4, now())
     ON CONFLICT (bill_id, period_anchor_date) DO UPDATE
       SET status = 'paid',
           matched_txn_id = EXCLUDED.matched_txn_id,
           marked_paid_at = now(),
           updated_at = now()`,
    [bill.id, bill.next_due_date, bill.tenant_id, txn.id],
  );

  // 0.24.10 — for drift-mode bills, snap the bill's expected
  // amount_cents to whatever just paid. The user explicitly chose
  // "drifts over time" for this bill, so the going-forward expected
  // should track the latest reality (e.g. car-wash membership goes
  // from $24 to $26 — the bill row updates so the budget shows the
  // new expected on the next cycle).
  //
  // Fixed-mode bills are left alone (the whole point of fixed is
  // "alert me if this changes"). Variable-mode bills are also left
  // alone (the cap, not the expected, is what matters there).
  //
  // Advance the cursor unless one-time.
  const next = advanceByFrequency(bill.next_due_date, bill.frequency);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (next) {
    params.push(next);
    sets.push(`next_due_date = $${params.length}`);
  }
  if (bill.amount_mode === 'drift') {
    const observedCents = Math.abs(Number(txn.amount_cents));
    if (observedCents > 0 && observedCents !== bill.amount_cents) {
      params.push(observedCents);
      sets.push(`amount_cents = $${params.length}`);
    }
  }
  if (sets.length > 0) {
    params.push(bill.id);
    await client.query(
      `UPDATE bills SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

  // Category fill-only-if-blank.
  if (txn.category_id === null && bill.category_id) {
    await client.query(
      `UPDATE transactions SET category_id = $1
        WHERE id = $2 AND category_id IS NULL`,
      [bill.category_id, txn.id],
    );
  }
}

// ── Periodic: flip past-due pending periods to overdue ───────────

/**
 * For each active bill whose next_due_date passed more than its
 * overdue_grace_days ago without a matched payment, insert a
 * bill_periods row with status='overdue' (or update the existing
 * row), advance the cursor, and emit an insight card.
 *
 * Idempotent — re-running is safe because bill_periods enforces
 * (bill_id, period_anchor_date) uniqueness and we ON CONFLICT DO
 * UPDATE only when transitioning from 'pending'.
 */
export async function sweepOverdueBills(today: string): Promise<{
  flipped: number;
}> {
  let flipped = 0;
  const billsRes = await query<BillRow & { paused_until: string | null }>(
    `SELECT id, tenant_id, name, amount_cents, frequency, next_due_date,
            category_id, active, amount_mode, amount_tolerance_cents,
            match_window_days, merchant_pattern, paused_until,
            overdue_grace_days
       FROM bills
      WHERE active = true
        AND (paused_until IS NULL OR paused_until < $1)
        AND next_due_date + (overdue_grace_days || ' days')::interval < $1`,
    [today],
  );

  for (const bill of billsRes.rows) {
    // Check if this period was already paid by a triage acceptance or
    // manual mark-paid — bill_periods will tell us.
    const existing = await query<{ status: string }>(
      `SELECT status FROM bill_periods
        WHERE bill_id = $1 AND period_anchor_date = $2`,
      [bill.id, bill.next_due_date],
    );
    if (existing.rows.length > 0 && existing.rows[0]!.status === 'paid') {
      // Edge case: paid via triage but cursor never advanced. Advance now.
      const next = advanceByFrequency(bill.next_due_date, bill.frequency);
      if (next) {
        await query(`UPDATE bills SET next_due_date = $1 WHERE id = $2`, [
          next,
          bill.id,
        ]);
      }
      continue;
    }

    // Flip / create the overdue period row.
    await query(
      `INSERT INTO bill_periods
         (bill_id, period_anchor_date, tenant_id, status)
       VALUES ($1, $2, $3, 'overdue')
       ON CONFLICT (bill_id, period_anchor_date) DO UPDATE
         SET status = CASE
               WHEN bill_periods.status = 'pending' THEN 'overdue'
               ELSE bill_periods.status
             END,
             updated_at = now()`,
      [bill.id, bill.next_due_date, bill.tenant_id],
    );

    // Insight card. Migration 071 adds 'bill_overdue' to the
    // insight_cards.kind CHECK constraint. Dedupe rides on
    // idx_insight_cards_open_source from 061: partial unique
    // (tenant_id, kind, source_id) WHERE dismissed_at IS NULL AND
    // source_id IS NOT NULL. The ON CONFLICT inference must spell
    // the predicate exactly.
    await query(
      `INSERT INTO insight_cards
         (tenant_id, kind, severity, title, body, source_kind, source_id)
       VALUES ($1, 'bill_overdue', 'warn',
               $2, $3,
               'bills', $4)
       ON CONFLICT (tenant_id, kind, source_id)
         WHERE dismissed_at IS NULL AND source_id IS NOT NULL
         DO NOTHING`,
      [
        bill.tenant_id,
        `${bill.name} is overdue`,
        `Due ${bill.next_due_date} (more than ${bill.overdue_grace_days} day${
          bill.overdue_grace_days === 1 ? '' : 's'
        } ago) with no matching payment found.`,
        bill.id,
      ],
    );

    // Advance the cursor so the next cycle starts ticking forward.
    const next = advanceByFrequency(bill.next_due_date, bill.frequency);
    if (next) {
      await query(`UPDATE bills SET next_due_date = $1 WHERE id = $2`, [
        next,
        bill.id,
      ]);
    }
    flipped += 1;
  }

  return { flipped };
}

// ── Triage resolution ────────────────────────────────────────────

export type TriageResolution = 'accepted' | 'rejected' | 'reassigned';

/**
 * User resolution from the /recurring triage section. `resolution`:
 *   accepted  — link this (bill, txn) pair (engine writes the
 *               bill_periods row, advances cursor, fills category).
 *   rejected  — the transaction is not this bill; just close the
 *               triage row.
 *   reassigned — the user chose a DIFFERENT bill from an ambiguous
 *               set; the chosen one is accepted (separate call),
 *               this row is closed as 'reassigned'.
 */
export async function resolveTriage(
  triageId: string,
  resolution: TriageResolution,
): Promise<{ matched_bill_id: string | null }> {
  return withTransaction(async (client) => {
    const r = await client.query<{
      bill_id: string;
      transaction_id: string;
      tenant_id: string;
    }>(
      `SELECT bill_id, transaction_id, tenant_id
         FROM bill_match_triage
        WHERE id = $1 AND resolved_at IS NULL
        FOR UPDATE`,
      [triageId],
    );
    if (r.rows.length === 0) return { matched_bill_id: null };
    const row = r.rows[0]!;

    await client.query(
      `UPDATE bill_match_triage
          SET resolved_at = now(), resolution = $2
        WHERE id = $1`,
      [triageId, resolution],
    );

    if (resolution !== 'accepted') return { matched_bill_id: null };

    // Re-load the bill + txn and apply the link.
    const billRes = await client.query<BillRow>(
      `SELECT id, tenant_id, name, amount_cents, frequency, next_due_date,
              category_id, active, amount_mode, amount_tolerance_cents,
              match_window_days, merchant_pattern, paused_until,
              overdue_grace_days
         FROM bills WHERE id = $1`,
      [row.bill_id],
    );
    const txnRes = await client.query<TxnRow>(
      `SELECT t.id, a.tenant_id, t.account_id, t.txn_date,
              t.amount_cents, t.raw_description, t.normalized_merchant,
              t.category_id
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.id = $1`,
      [row.transaction_id],
    );
    if (billRes.rows.length && txnRes.rows.length) {
      await linkBillToTxn(client, billRes.rows[0]!, txnRes.rows[0]!);
      // Also close any sibling triage rows for this txn (ambiguous set).
      await client.query(
        `UPDATE bill_match_triage
            SET resolved_at = now(), resolution = 'reassigned'
          WHERE transaction_id = $1
            AND id <> $2
            AND resolved_at IS NULL`,
        [row.transaction_id, triageId],
      );
      return { matched_bill_id: row.bill_id };
    }
    return { matched_bill_id: null };
  });
}
