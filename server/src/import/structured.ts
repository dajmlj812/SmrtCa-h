import type { AccountType, ParsedTransaction, RowError } from './types.js';
import { looksLikeOfx, parseOfx } from './parsers/ofx.js';
import { parseQif } from './parsers/qif.js';

/**
 * Result of parsing a "structured" import — OFX, QFX, or QIF.
 *
 * Unlike CSV/XLSX (which go through the headers + mapRow column-mapping
 * pipeline), these formats hand us fully-typed transactions in one
 * shot. The importer routes structured files past the column-mapping
 * step and feeds them straight into dedup + persistence.
 */
export interface StructuredParseResult {
  formatId: string;
  formatName: string;
  suggestedAccountType: AccountType;
  transactions: ParsedTransaction[];
  errors: RowError[];
}

const EXT_HANDLERS: Record<
  string,
  (buffer: Buffer, filename: string) => StructuredParseResult | null
> = {
  qif: (buffer) => {
    const r = parseQif(buffer);
    return {
      formatId: r.formatId,
      formatName: r.formatName,
      suggestedAccountType: 'checking',
      transactions: r.transactions,
      errors: r.errors,
    };
  },
  ofx: (buffer, filename) => {
    const r = parseOfx(buffer, filename);
    return {
      formatId: r.formatId,
      formatName: r.formatName,
      suggestedAccountType: 'checking',
      transactions: r.transactions,
      errors: r.errors,
    };
  },
  qfx: (buffer, filename) => {
    const r = parseOfx(buffer, filename);
    return {
      formatId: r.formatId,
      formatName: r.formatName,
      suggestedAccountType: 'checking',
      transactions: r.transactions,
      errors: r.errors,
    };
  },
};

/**
 * Returns a parsed structured result if the file's extension or
 * content sniffs as OFX/QFX/QIF; otherwise null (caller falls back
 * to the CSV/XLSX pipeline).
 */
export function tryParseStructured(
  filename: string,
  buffer: Buffer,
): StructuredParseResult | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const handler = EXT_HANDLERS[ext];
  if (handler) return handler(buffer, filename);

  // Content sniff fallback: someone may have downloaded an OFX file
  // with an unhelpful extension. QIF detection is unreliable from
  // content alone (lots of plain-text files start with '!') so we
  // only sniff OFX here.
  if (looksLikeOfx(buffer)) {
    const r = parseOfx(buffer, filename);
    return {
      formatId: r.formatId,
      formatName: r.formatName,
      suggestedAccountType: 'checking',
      transactions: r.transactions,
      errors: r.errors,
    };
  }
  return null;
}
