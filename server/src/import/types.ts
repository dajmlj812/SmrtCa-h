export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit_card'
  | 'cash'
  | 'investment'
  | 'loan'
  | 'other'
  // Phase 7.0 — manual wealth tracking. These accounts have no
  // transactions; their value is held in opening_balance_cents and the
  // user marks-to-market periodically. Liabilities are stored with a
  // negative balance by convention.
  | 'manual_asset'
  | 'manual_liability';

export const ACCOUNT_TYPES: AccountType[] = [
  'checking',
  'savings',
  'credit_card',
  'cash',
  'investment',
  'loan',
  'other',
  'manual_asset',
  'manual_liability',
];

export interface RawRow {
  [header: string]: string;
}

export interface ParsedFile {
  headers: string[];
  rows: RawRow[];
}

/** A transaction extracted from one import row, before persistence. */
export interface ParsedTransaction {
  txnDate: string; // ISO YYYY-MM-DD
  postDate: string | null;
  amountCents: number;
  rawDescription: string;
  sourceCategory: string | null;
  sourceType: string | null;
  memo: string | null;
  balanceCents: number | null;
  /**
   * Bank-provided unique reference for this transaction, when the
   * source format supplies one. OFX has `FITID`; Plaid has
   * `transaction_id`. CSV/XLSX/QIF generally don't.
   *
   * 0.14.7: when present, the dedup hash derives directly from this
   * reference rather than the (date, amount, description) tuple, so
   * re-importing the same OFX file or syncing the same Plaid window
   * is idempotent EVEN IF the bank rewrites the description (mid-
   * settlement renames, merchant cleanup, etc.).
   */
  bankReference?: string | null;
}

export interface RowError {
  rowNumber: number; // 1-based, excludes the header row
  message: string;
  raw: RawRow;
}
