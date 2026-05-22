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
});
