import { parseAmountToCents, tryParseAmountToCents } from '../domain/money.js';
import { parseDateToISO, type DateOrder } from '../domain/dates.js';
import type { AccountType, ParsedTransaction, RawRow } from './types.js';

/** Collapse the heavy whitespace padding banks put in description fields. */
export function cleanDescription(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export interface ImportFormat {
  id: string;
  name: string;
  suggestedAccountType: AccountType;
  /** Column headers that must all be present for this format to match. */
  signature: string[];
  mapRow(row: RawRow): ParsedTransaction;
}

const BUILT_IN_FORMATS: ImportFormat[] = [
  {
    id: 'chase_credit_card',
    name: 'Chase — Credit Card',
    suggestedAccountType: 'credit_card',
    signature: [
      'Transaction Date',
      'Post Date',
      'Description',
      'Category',
      'Type',
      'Amount',
    ],
    mapRow(row) {
      return {
        txnDate: parseDateToISO(required(row, 'Transaction Date')),
        postDate: optionalDate(row['Post Date']),
        amountCents: parseAmountToCents(required(row, 'Amount')),
        rawDescription: cleanDescription(row['Description']),
        sourceCategory: blankToNull(row['Category']),
        sourceType: blankToNull(row['Type']),
        memo: blankToNull(row['Memo']),
        balanceCents: null,
      };
    },
  },
  {
    id: 'chase_bank',
    name: 'Chase — Checking / Savings',
    suggestedAccountType: 'checking',
    signature: ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance'],
    mapRow(row) {
      const posted = parseDateToISO(required(row, 'Posting Date'));
      return {
        txnDate: posted,
        postDate: posted,
        amountCents: parseAmountToCents(required(row, 'Amount')),
        rawDescription: cleanDescription(row['Description']),
        sourceCategory: null,
        sourceType: blankToNull(row['Type']),
        memo: blankToNull(row['Details']),
        balanceCents: tryParseAmountToCents(row['Balance']),
      };
    },
  },
];

export interface FormatSummary {
  id: string;
  name: string;
  suggestedAccountType: AccountType;
}

/**
 * Pseudo-format ids that aren't in BUILT_IN_FORMATS but ARE recognized
 * by the structured-import path (parsers/ofx.ts, parsers/qif.ts).
 * They're advertised in /api/imports/formats so the UI dropdown lists
 * them, but selecting one has no effect: the importer routes by file
 * extension, not by `formatId`, for structured files.
 */
const STRUCTURED_FORMATS: FormatSummary[] = [
  { id: 'ofx', name: 'OFX (Open Financial Exchange)', suggestedAccountType: 'checking' },
  { id: 'qfx', name: 'Quicken QFX', suggestedAccountType: 'checking' },
  { id: 'qif', name: 'Quicken QIF', suggestedAccountType: 'checking' },
];

export function listFormats(): FormatSummary[] {
  return [
    ...BUILT_IN_FORMATS.map(({ id, name, suggestedAccountType }) => ({
      id,
      name,
      suggestedAccountType,
    })),
    ...STRUCTURED_FORMATS,
  ];
}

export function getFormat(id: string): ImportFormat | undefined {
  return BUILT_IN_FORMATS.find((f) => f.id === id);
}

/** Detect a built-in format by checking that every signature column is present. */
export function detectFormat(headers: string[]): ImportFormat | undefined {
  const present = new Set(headers.map((h) => h.trim().toLowerCase()));
  return BUILT_IN_FORMATS.find((format) =>
    format.signature.every((col) => present.has(col.toLowerCase())),
  );
}

// --- Generic / user-defined column mapping ---------------------------------

export interface ColumnMapping {
  txnDate: string;
  postDate?: string;
  /** A single signed-amount column... */
  amount?: string;
  /** ...or a separate debit/credit pair (banks vary). */
  debit?: string;
  credit?: string;
  description: string;
  category?: string;
  type?: string;
  memo?: string;
  balance?: string;
  dateOrder?: DateOrder;
}

/** Build an ad-hoc format from a user-supplied column mapping. */
export function buildGenericFormat(mapping: ColumnMapping): ImportFormat {
  const order: DateOrder = mapping.dateOrder ?? 'mdy';
  return {
    id: 'generic',
    name: 'Custom column mapping',
    suggestedAccountType: 'other',
    signature: [],
    mapRow(row) {
      let amountCents: number;
      if (mapping.amount) {
        amountCents = parseAmountToCents(required(row, mapping.amount));
      } else {
        const debit = mapping.debit ? tryParseAmountToCents(row[mapping.debit]) : null;
        const credit = mapping.credit ? tryParseAmountToCents(row[mapping.credit]) : null;
        if (debit) amountCents = -Math.abs(debit);
        else if (credit) amountCents = Math.abs(credit);
        else amountCents = 0;
      }
      return {
        txnDate: parseDateToISO(required(row, mapping.txnDate), order),
        postDate: mapping.postDate ? optionalDate(row[mapping.postDate], order) : null,
        amountCents,
        rawDescription: cleanDescription(row[mapping.description]),
        sourceCategory: mapping.category ? blankToNull(row[mapping.category]) : null,
        sourceType: mapping.type ? blankToNull(row[mapping.type]) : null,
        memo: mapping.memo ? blankToNull(row[mapping.memo]) : null,
        balanceCents: mapping.balance ? tryParseAmountToCents(row[mapping.balance]) : null,
      };
    },
  };
}

// --- helpers ---------------------------------------------------------------

function required(row: RawRow, key: string): string {
  const value = row[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing value for column "${key}"`);
  }
  return value;
}

function optionalDate(value: string | undefined, order: DateOrder = 'mdy'): string | null {
  if (!value || value.trim() === '') return null;
  return parseDateToISO(value, order);
}

function blankToNull(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' ? null : v;
}
