import { describe, it, expect } from 'vitest';
import { assignDedupHashes } from '../../src/import/dedup.js';
import type { ParsedTransaction } from '../../src/import/types.js';

function txn(over: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    txnDate: '2026-05-01',
    postDate: null,
    amountCents: -100,
    rawDescription: 'TEST MERCHANT',
    sourceCategory: null,
    sourceType: null,
    memo: null,
    balanceCents: null,
    ...over,
  };
}

describe('assignDedupHashes', () => {
  it('produces a 64-character hex hash per transaction', () => {
    const [hash] = assignDedupHashes([txn()]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives distinct transactions distinct hashes', () => {
    const hashes = assignDedupHashes([
      txn({ amountCents: -100 }),
      txn({ amountCents: -200 }),
      txn({ txnDate: '2026-06-01' }),
      txn({ rawDescription: 'OTHER MERCHANT' }),
    ]);
    expect(new Set(hashes).size).toBe(4);
  });

  it('gives genuinely identical rows distinct hashes (occurrence counter)', () => {
    const hashes = assignDedupHashes([txn(), txn(), txn()]);
    expect(new Set(hashes).size).toBe(3);
  });

  it('is deterministic — same input yields the same hashes', () => {
    const input = [txn({ amountCents: -1 }), txn({ amountCents: -2 })];
    expect(assignDedupHashes(input)).toEqual(assignDedupHashes(input));
  });

  it('treats descriptions case-insensitively', () => {
    const upper = assignDedupHashes([txn({ rawDescription: 'COFFEE' })]);
    const lower = assignDedupHashes([txn({ rawDescription: 'coffee' })]);
    expect(upper[0]).toBe(lower[0]);
  });

  // ── 0.14.7: bank-reference-keyed dedup (closes KI-05) ─────────

  it('bank-ref-keyed rows survive a description rewrite', () => {
    // Same FITID, different cleaned-up descriptions — must dedup.
    const [pre] = assignDedupHashes([
      txn({ bankReference: 'FITID-1', rawDescription: 'STARBUCKS #4012' }),
    ]);
    const [post] = assignDedupHashes([
      txn({ bankReference: 'FITID-1', rawDescription: 'Starbucks' }),
    ]);
    expect(pre).toBe(post);
  });

  it('different bank refs do not collide even on otherwise-identical rows', () => {
    const [ha] = assignDedupHashes([txn({ bankReference: 'A' })]);
    const [hb] = assignDedupHashes([txn({ bankReference: 'B' })]);
    expect(ha).not.toBe(hb);
  });

  it('absent bank ref falls back to the (date, amount, desc) heuristic — the pre-fix behavior', () => {
    // No ref: descriptions matter, so 'STARBUCKS #4012' vs 'Starbucks'
    // produce DIFFERENT hashes. This is exactly the failure mode that
    // motivated KI-05 — without a ref there's nothing better we can do.
    const [ha] = assignDedupHashes([txn({ rawDescription: 'STARBUCKS #4012' })]);
    const [hb] = assignDedupHashes([txn({ rawDescription: 'Starbucks' })]);
    expect(ha).not.toBe(hb);
  });

  it('two rows with the same bank ref in one batch still get distinct hashes (occurrence counter)', () => {
    // Pathological case — feed sent the same FITID twice in one batch.
    // We keep both rather than silently dropping; the ON CONFLICT in
    // persistBatch will collide the second-import-of-either with the
    // first surviving row.
    const hashes = assignDedupHashes([
      txn({ bankReference: 'DUP' }),
      txn({ bankReference: 'DUP' }),
    ]);
    expect(new Set(hashes).size).toBe(2);
  });
});
