import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';

/**
 * Transfer detection — pair a debit on account A with the matching credit on
 * account B and tag both with a shared `transfer_group_id`. So they no longer
 * skew "spending" totals.
 *
 * Match rules (strict on purpose; the user can manually link edge cases):
 *
 * - Amounts are exact opposites (e.g. -1500 cents on A, +1500 cents on B).
 * - Transactions are on DIFFERENT accounts owned by the user.
 * - Account currencies match (no FX guessing).
 * - Transaction dates are within `MAX_DATE_DIFF_DAYS` of each other (ACH
 *   transfers post on the destination side 1–3 business days after the
 *   sending side).
 * - Neither transaction is already part of a transfer group.
 *
 * Ambiguity: when one transaction has multiple candidates, the closest date
 * wins. After that pair is taken both sides are removed from consideration —
 * one transaction belongs to at most one transfer group.
 */

export const MAX_DATE_DIFF_DAYS = 5;

export interface DetectedPair {
  groupId: string;
  aId: string;
  bId: string;
  dateDiffDays: number;
}

export interface DetectSummary {
  scanned: number;
  paired: number;
  pairs: DetectedPair[];
}

interface CandidateRow {
  a_id: string;
  b_id: string;
  date_diff: number;
}

/** Scan all unpaired transactions and create transfer groups for matching pairs. */
export async function detectTransfers(opts: {
  accountId?: string;
} = {}): Promise<DetectSummary> {
  // The self-join surfaces every candidate; we then greedily pick the
  // closest-date match per transaction in JS. `a.id < b.id` removes the
  // mirror-image duplicate (a,b)/(b,a) pair.
  const accountFilter = opts.accountId ? 'AND ($1::uuid IS NULL OR a.account_id = $1 OR b.account_id = $1)' : '';
  const params = opts.accountId ? [opts.accountId] : [];

  const candidates = await pool.query<CandidateRow>(
    `SELECT a.id AS a_id,
            b.id AS b_id,
            ABS(a.txn_date - b.txn_date) AS date_diff
       FROM transactions a
       JOIN transactions b
         ON a.amount_cents = -b.amount_cents
        AND a.account_id <> b.account_id
        AND ABS(a.txn_date - b.txn_date) <= ${MAX_DATE_DIFF_DAYS}
        AND a.id < b.id
       JOIN accounts aa ON aa.id = a.account_id
       JOIN accounts bb ON bb.id = b.account_id
      WHERE a.transfer_group_id IS NULL
        AND b.transfer_group_id IS NULL
        AND aa.currency = bb.currency
        ${accountFilter}
      ORDER BY ABS(a.txn_date - b.txn_date) ASC,
               ABS(a.amount_cents) DESC`,
    params,
  );

  const used = new Set<string>();
  const pairs: DetectedPair[] = [];
  for (const row of candidates.rows) {
    if (used.has(row.a_id) || used.has(row.b_id)) continue;
    used.add(row.a_id);
    used.add(row.b_id);
    pairs.push({
      groupId: randomUUID(),
      aId: row.a_id,
      bId: row.b_id,
      dateDiffDays: Number(row.date_diff),
    });
  }

  if (pairs.length > 0) {
    await withTransaction(async (client) => {
      for (const p of pairs) {
        await client.query(
          `UPDATE transactions SET transfer_group_id = $1
            WHERE id = ANY($2::uuid[])`,
          [p.groupId, [p.aId, p.bId]],
        );
      }
    });
  }

  return {
    scanned: candidates.rows.length,
    paired: pairs.length,
    pairs,
  };
}

/**
 * Manually pair two transactions. Clears any pre-existing group on either
 * side first, then creates a new group containing both. Refuses to pair two
 * transactions on the same account — a self-account transfer doesn't make
 * sense.
 */
export async function linkTransfer(
  aId: string,
  bId: string,
): Promise<{ groupId: string }> {
  if (aId === bId) {
    throw new Error('Cannot pair a transaction with itself');
  }
  const rows = await pool.query<{
    id: string;
    account_id: string;
    transfer_group_id: string | null;
  }>(
    `SELECT id, account_id, transfer_group_id
       FROM transactions
      WHERE id = ANY($1::uuid[])`,
    [[aId, bId]],
  );
  if (rows.rowCount !== 2) {
    throw new Error('One or both transactions not found');
  }
  const [first, second] = rows.rows;
  if (first!.account_id === second!.account_id) {
    throw new Error('Both transactions are on the same account');
  }

  const groupId = randomUUID();
  await withTransaction(async (client) => {
    // Clear any existing groups these transactions belonged to (so we don't
    // leave a dangling singleton with the old group_id on a third row).
    const existingGroups = [first!.transfer_group_id, second!.transfer_group_id].filter(
      (g): g is string => g !== null,
    );
    if (existingGroups.length > 0) {
      await client.query(
        `UPDATE transactions SET transfer_group_id = NULL
          WHERE transfer_group_id = ANY($1::uuid[])`,
        [existingGroups],
      );
    }
    await client.query(
      `UPDATE transactions SET transfer_group_id = $1
        WHERE id = ANY($2::uuid[])`,
      [groupId, [aId, bId]],
    );
  });
  return { groupId };
}

/** Clear the transfer group from every transaction in it. */
export async function unlinkTransfer(groupId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE transactions SET transfer_group_id = NULL
      WHERE transfer_group_id = $1`,
    [groupId],
  );
  return result.rowCount ?? 0;
}
