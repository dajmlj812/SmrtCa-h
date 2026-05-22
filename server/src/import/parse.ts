import { parse as parseCsvSync } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import type { ParsedFile, RawRow } from './types.js';

/** Parse an uploaded CSV or XLSX file into headers + string-valued rows. */
export async function parseImportFile(
  filename: string,
  buffer: Buffer,
): Promise<ParsedFile> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'xlsx' || ext === 'xls') return parseXlsx(buffer);
  return parseCsv(buffer); // default: treat as CSV
}

function parseCsv(buffer: Buffer): ParsedFile {
  const records = parseCsvSync(buffer, {
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
    trim: true,
  }) as string[][];

  if (records.length === 0) return { headers: [], rows: [] };

  const headers = (records[0] ?? []).map((h) => h.trim());
  const rows: RawRow[] = records.slice(1).map((record) => {
    const row: RawRow = {};
    headers.forEach((header, i) => {
      row[header] = (record[i] ?? '').trim();
    });
    return row;
  });
  return { headers, rows };
}

async function parseXlsx(buffer: Buffer): Promise<ParsedFile> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's bundled types predate the generic Buffer in @types/node.
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headers: string[] = [];
  const rows: RawRow[] = [];
  sheet.eachRow((excelRow, rowNumber) => {
    // exceljs row.values is 1-indexed; index 0 is always empty.
    const values = (excelRow.values as unknown[]).slice(1);
    if (rowNumber === 1) {
      values.forEach((v) => headers.push(cellToString(v).trim()));
      return;
    }
    const row: RawRow = {};
    headers.forEach((header, i) => {
      row[header] = cellToString(values[i]).trim();
    });
    rows.push(row);
  });
  return { headers, rows };
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'object') {
    // exceljs rich-text / formula / hyperlink cell objects
    const obj = value as Record<string, unknown>;
    if (typeof obj['text'] === 'string') return obj['text'];
    if (obj['result'] !== undefined && obj['result'] !== null) {
      return String(obj['result']);
    }
    if (Array.isArray(obj['richText'])) {
      return (obj['richText'] as Array<{ text?: string }>)
        .map((part) => part.text ?? '')
        .join('');
    }
    return '';
  }
  return String(value);
}
