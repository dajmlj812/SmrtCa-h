import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseImportFile } from '../../src/import/parse.js';

/**
 * 0.14.7 — regression test for KI-06 (XLSX date cells).
 *
 * Excel stores dates as serial numbers (days since 1899-12-30, with
 * the 1900-leap-year quirk). exceljs converts those to JS `Date`
 * instances, which historically could land on the previous day in
 * the user's local timezone if the workbook was created in a
 * different zone. Our `cellToString` extracts the calendar date via
 * `getUTC*` so the rendered YYYY-MM-DD matches the spreadsheet cell
 * verbatim — verified here across year boundaries, month boundaries,
 * a leap-year-day, and a date that historically straddled negative-
 * UTC-offset timezones (Jan 1 00:00 UTC ↔ Dec 31 PST).
 *
 * Round-trips through exceljs itself so the fixture is deterministic
 * — no committed `.xlsx` binary.
 */

async function buildXlsxBuffer(rows: Array<[string, string]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('s');
  sheet.addRow(['Date', 'Description']);
  for (const [dateStr, desc] of rows) {
    const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
    // Construct a UTC midnight Date — this is the canonical representation
    // exceljs serializes correctly across host timezones.
    const dt = new Date(Date.UTC(y, m - 1, d));
    sheet.addRow([dt, desc]);
  }
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

describe('XLSX date parsing (KI-06 regression)', () => {
  it('preserves calendar dates verbatim across year, month, and leap-day boundaries', async () => {
    const cases: Array<[string, string]> = [
      ['2026-01-01', 'Jan 1 — year start, UTC-offset trap'],
      ['2026-05-31', 'May 31 — last day of a 31-day month'],
      ['2026-06-01', 'Jun 1 — first day of next month'],
      ['2024-02-29', 'Feb 29 — leap day'],
      ['2026-12-31', 'Dec 31 — year end'],
    ];

    const buf = await buildXlsxBuffer(cases);
    const parsed = await parseImportFile('test.xlsx', buf);

    expect(parsed.headers).toEqual(['Date', 'Description']);
    expect(parsed.rows).toHaveLength(cases.length);
    cases.forEach(([expectedDate, expectedDesc], i) => {
      expect(parsed.rows[i]!['Date']).toBe(expectedDate);
      expect(parsed.rows[i]!['Description']).toBe(expectedDesc);
    });
  });

  it('returns empty strings for missing date cells without crashing', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('s');
    sheet.addRow(['Date', 'Description']);
    sheet.addRow([null, 'No date']);
    const ab = await wb.xlsx.writeBuffer();
    const parsed = await parseImportFile(
      'test.xlsx',
      Buffer.from(ab as ArrayBuffer),
    );
    expect(parsed.rows[0]!['Date']).toBe('');
    expect(parsed.rows[0]!['Description']).toBe('No date');
  });
});
