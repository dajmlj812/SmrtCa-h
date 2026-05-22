export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit_card'
  | 'cash'
  | 'investment'
  | 'loan'
  | 'other';

export const ACCOUNT_TYPES: AccountType[] = [
  'checking',
  'savings',
  'credit_card',
  'cash',
  'investment',
  'loan',
  'other',
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
}

export interface RowError {
  rowNumber: number; // 1-based, excludes the header row
  message: string;
  raw: RawRow;
}
