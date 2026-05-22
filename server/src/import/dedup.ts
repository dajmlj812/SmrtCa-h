import { createHash } from 'node:crypto';
import type { ParsedTransaction } from './types.js';

function baseHash(t: ParsedTransaction): string {
  return createHash('sha256')
    .update(`${t.txnDate}|${t.amountCents}|${t.rawDescription.toLowerCase()}`)
    .digest('hex');
}

/**
 * Assign a stable dedup hash to each transaction. Genuinely identical rows
 * within one file (e.g. two coffees of the same price on the same day) get
 * distinct hashes via an occurrence counter, so they are all kept — while
 * re-importing the same file still collides and is skipped.
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
