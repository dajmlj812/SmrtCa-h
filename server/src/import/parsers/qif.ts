import { parseAmountToCents } from '../../domain/money.js';
import type { ParsedTransaction, RowError } from '../types.js';

/**
 * Parse a Quicken Interchange Format (QIF) file.
 *
 * Format: line-based plain text. Sections start with `!Type:Bank` /
 * `!Type:CCard` / `!Type:Cash` / `!Type:Invst` / `!Account` etc.
 * Within a section, each record is a series of single-letter-tagged
 * lines terminated by `^`. Common tags:
 *
 *   D  date
 *   T  amount (signed)
 *   U  amount (Quicken's UTF-8 mirror of T; tolerated)
 *   P  payee
 *   M  memo
 *   L  category
 *   N  check number / reference
 *   C  cleared status
 *   A  address line
 *   ^  end of record
 *
 * QIF dates come in many flavors. We accept M/D/YY[YY], MM-DD-YY[YY],
 * YYYY-MM-DD, and Quicken's `12'34` (apostrophe = year 2034) variants.
 * Banks emit US-style MDY by default; non-US exports can still come
 * through as YMD via the ISO branch.
 */
export interface QifParseResult {
  formatId: string;
  formatName: string;
  transactions: ParsedTransaction[];
  errors: RowError[];
}

interface QifRecord {
  D?: string;
  T?: string;
  P?: string;
  M?: string;
  L?: string;
  N?: string;
  C?: string;
}

export function parseQif(buffer: Buffer): QifParseResult {
  const text = stripBom(buffer.toString('utf-8'));
  const lines = text.split(/\r\n|\r|\n/);

  const transactions: ParsedTransaction[] = [];
  const errors: RowError[] = [];
  let current: QifRecord = {};
  let recordStartLine = 0;
  let recordCounter = 0;
  let inIgnoredSection = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === '') continue;

    if (line.startsWith('!')) {
      // Section header. We support Bank, CCard, Cash, Oth A, Oth L.
      // Investment + Account-list sections are skipped so a mixed
      // file doesn't blow up the parser.
      const header = line.slice(1).toLowerCase();
      inIgnoredSection =
        header.startsWith('account') ||
        header.startsWith('type:cat') ||
        header.startsWith('type:class') ||
        header.startsWith('type:invst') ||
        header.startsWith('type:memorized') ||
        header.startsWith('type:security') ||
        header.startsWith('type:prices');
      current = {};
      continue;
    }
    if (inIgnoredSection) continue;

    if (line === '^') {
      if (recordHasContent(current)) {
        recordCounter += 1;
        try {
          transactions.push(buildTransaction(current));
        } catch (err) {
          errors.push({
            rowNumber: recordCounter,
            message: err instanceof Error ? err.message : String(err),
            raw: { ...current } as Record<string, string>,
          });
        }
      }
      current = {};
      recordStartLine = i + 1;
      continue;
    }

    const tag = line[0]!;
    const value = line.slice(1);
    switch (tag) {
      case 'D':
        current.D = value;
        break;
      case 'T':
      case 'U':
        // T is canonical; U mirrors T in Quicken's modern exports.
        // If both are present and disagree, T wins.
        if (tag === 'T' || current.T === undefined) current.T = value;
        break;
      case 'P':
        current.P = value;
        break;
      case 'M':
        current.M = value;
        break;
      case 'L':
        current.L = value;
        break;
      case 'N':
        current.N = value;
        break;
      case 'C':
        current.C = value;
        break;
      default:
        // Address lines (A), split lines (S/E/$), and other tags are
        // ignored — they don't drive ParsedTransaction.
        break;
    }
    if (!current.D && !current.T && !current.P) {
      // Defensive: when nothing has been captured yet, record the
      // starting line so error messages can point at it.
      recordStartLine = i + 1;
    }
  }

  // Tolerate trailing records that lack a final ^.
  if (recordHasContent(current)) {
    recordCounter += 1;
    try {
      transactions.push(buildTransaction(current));
    } catch (err) {
      errors.push({
        rowNumber: recordCounter,
        message: err instanceof Error ? err.message : String(err),
        raw: { ...current } as Record<string, string>,
      });
    }
  }

  return {
    formatId: 'qif',
    formatName: 'Quicken QIF',
    transactions,
    errors,
  };
}

function recordHasContent(rec: QifRecord): boolean {
  return Object.values(rec).some((v) => v !== undefined && v !== '');
}

function buildTransaction(rec: QifRecord): ParsedTransaction {
  if (!rec.D) throw new Error('QIF record missing D (date)');
  if (!rec.T) throw new Error('QIF record missing T (amount)');

  const txnDate = parseQifDate(rec.D);
  const amountCents = parseAmountToCents(rec.T);
  const description = cleanQifText(rec.P ?? '');
  const memo = blankToNull(rec.M);
  const sourceCategory = blankToNull(rec.L);
  // Quicken's N field carries the check number or reference id.
  // Roll it into memo so downstream UI can show it.
  const combinedMemo =
    rec.N && rec.N.trim() !== ''
      ? memo
        ? `${memo} (ref ${rec.N.trim()})`
        : `ref ${rec.N.trim()}`
      : memo;

  return {
    txnDate,
    postDate: txnDate,
    amountCents,
    rawDescription: description || combinedMemo || '(unspecified)',
    sourceCategory,
    sourceType: null,
    memo: combinedMemo,
    balanceCents: null,
  };
}

/**
 * Quicken dates accept many shapes:
 *  - YYYY-MM-DD            (ISO)
 *  - MM/DD/YY              (US default)
 *  - MM/DD/YYYY
 *  - DD-MM-YY              (Euro, dash separator)
 *  - 1/ 3'05              (apostrophe-prefixed year >= 2000)
 *  - 1/ 3/95              (slash-prefixed 2-digit year, <70 -> 2000+, >=70 -> 1900+)
 *
 * We strip stray whitespace, then try ISO first, then numeric splits.
 */
export function parseQifDate(input: string): string {
  const compact = input.replace(/\s+/g, '');

  const iso = compact.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return buildIso(iso[1]!, iso[2]!, iso[3]!);

  // Quicken's apostrophe means "year 2000+"; the digit after is the year.
  // 1/3'05 -> 2005-01-03; 12/31'99 -> 2099-12-31 (treated literally).
  const apos = compact.match(/^(\d{1,2})\/(\d{1,2})'(\d{1,2})$/);
  if (apos) {
    const year = 2000 + Number(apos[3]!);
    return buildIso(String(year), apos[1]!, apos[2]!);
  }

  const slash = compact.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const m = slash[1]!;
    const d = slash[2]!;
    let y = slash[3]!;
    if (y.length === 2) {
      const n = Number(y);
      y = String(n >= 70 ? 1900 + n : 2000 + n);
    }
    return buildIso(y, m, d);
  }

  throw new Error(`Unrecognized QIF date: "${input}"`);
}

function buildIso(year: string, month: string, day: string): string {
  const mm = month.padStart(2, '0');
  const dd = day.padStart(2, '0');
  if (Number(mm) < 1 || Number(mm) > 12)
    throw new Error(`QIF date has invalid month: "${month}"`);
  if (Number(dd) < 1 || Number(dd) > 31)
    throw new Error(`QIF date has invalid day: "${day}"`);
  return `${year}-${mm}-${dd}`;
}

function cleanQifText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function blankToNull(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' ? null : v;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
