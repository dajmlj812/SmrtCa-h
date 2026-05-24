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
 * - Transaction dates are within `MAX_DATE_DIFF_DAYS` of each other.
 * - Neither transaction is already part of a transfer group.
 * - **0.14.2**: both accounts belong to the caller's tenant.
 *   Pre-0.14.2 the detector happily paired account A in tenant X
 *   with account B in tenant Y, creating a cross-tenant "transfer"
 *   that broke both households' spending totals and leaked merchant
 *   strings into each other's transactions page.
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

/**
 * Scan unpaired transactions and create transfer groups for matching
 * pairs WITHIN A TENANT. Caller-tenant scoping is mandatory.
 */
export async function detectTransfers(opts: {
  tenantId: string;
  accountId?: string;
}): Promise<DetectSummary> {
  if (!opts.tenantId) {
    throw new Error('detectTransfers requires a tenantId');
  }
  // The candidate join requires BOTH legs' accounts to be in this
  // tenant — that's the security gate. The optional accountId filter
  // narrows further.
  const params: unknown[] = [opts.tenantId];
  let accountFilter = '';
  if (opts.accountId) {
    params.push(opts.accountId);
    accountFilter = `AND ($2::uuid IS NULL OR a.account_id = $2 OR b.account_id = $2)`;
  }

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
        AND aa.tenant_id = $1
        AND bb.tenant_id = $1
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
 * side first, then creates a new group containing both.
 *
 * 0.14.2 — refuses to pair when either leg belongs to a different
 * tenant than the caller's. Returns the same "not found" shape as
 * a truly-unknown id so cross-tenant probes can't enumerate.
 */
export async function linkTransfer(
  aId: string,
  bId: string,
  tenantId: string,
): Promise<{ groupId: string }> {
  if (!tenantId) {
    throw new Error('linkTransfer requires a tenantId');
  }
  if (aId === bId) {
    throw new Error('Cannot pair a transaction with itself');
  }
  // The accounts join doubles as the tenant check — a leg whose
  // account is in another tenant simply doesn't show up in `rows`.
  const rows = await pool.query<{
    id: string;
    account_id: string;
    transfer_group_id: string | null;
  }>(
    `SELECT t.id, t.account_id, t.transfer_group_id
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE a.tenant_id = $1
        AND t.id = ANY($2::uuid[])`,
    [tenantId, [aId, bId]],
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

/**
 * Clear the transfer group from every transaction in it. Scoped:
 * the UPDATE only touches transactions whose account is in the
 * caller's tenant, so a group containing legs from another tenant
 * is invisible.
 */
export async function unlinkTransfer(
  groupId: string,
  tenantId: string,
): Promise<number> {
  if (!tenantId) {
    throw new Error('unlinkTransfer requires a tenantId');
  }
  const result = await pool.query(
    `UPDATE transactions t
        SET transfer_group_id = NULL
       FROM accounts a
      WHERE t.account_id = a.id
        AND a.tenant_id = $1
        AND t.transfer_group_id = $2`,
    [tenantId, groupId],
  );
  return result.rowCount ?? 0;
}
