import { createHash } from 'node:crypto';
import type { ParsedTransaction } from './types.js';

/**
 * Per-transaction base hash. Two paths:
 *
 *   • bankReference present (OFX FITID, Plaid transaction_id) →
 *     sha256("ref:" + value). Re-importing the same source file
 *     produces the same hash even if the bank later rewrites the
 *     description (merchant-name cleanup post-settlement, etc.) or
 *     amends the amount in a correction posting.
 *
 *   • bankReference absent (CSV / XLSX / QIF) → sha256(date | amount
 *     | description). Heuristic, same as Phase 1.
 *
 * 0.14.7 (closes KI-05): the bank-ref path makes OFX + Plaid
 * imports deterministically idempotent. Overlapping CSV exports
 * with distinct-but-identical rows can still confuse the heuristic
 * path — that's a fundamental limitation when the source provides
 * no unique id.
 */
function baseHash(t: ParsedTransaction): string {
  const ref = t.bankReference?.trim();
  if (ref) {
    return createHash('sha256').update(`ref:${ref}`).digest('hex');
  }
  return createHash('sha256')
    .update(`${t.txnDate}|${t.amountCents}|${t.rawDescription.toLowerCase()}`)
    .digest('hex');
}

/**
 * Assign a stable dedup hash to each transaction. Genuinely identical rows
 * within one file (two coffees of the same price on the same day, no
 * bank ref) get distinct hashes via an occurrence counter, so they are
 * all kept — while re-importing the same file still collides and is
 * skipped.
 *
 * Note: the occurrence-counter quirk only applies to the heuristic
 * path. A bank-ref-keyed hash is already globally unique by
 * construction, so a duplicate `bankReference` in the same batch
 * means the upstream feed sent us the same row twice — keep one,
 * drop the other (collide via the counter at occurrence 1+).
 */
export function assignDedupHashes(transactions: ParsedTransaction[]): string[] {
  const seen = new Map<string, number>();
  return transactions.map((t) => {
    const base = baseHash(t);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return createHash('sha256').update(`${base}:${occurrence}`).digest('hex');
  });
}
