export type DateOrder = 'mdy' | 'dmy' | 'ymd';

/**
 * Normalize a date string to ISO 'YYYY-MM-DD'.
 * Supports ISO dates and slash/dash separated numeric dates. For ambiguous
 * numeric dates the `order` argument decides (US bank exports default to mdy).
 */
export function parseDateToISO(input: string, order: DateOrder = 'mdy'): string {
  const s = input.trim();
  if (s === '') throw new Error('Empty date');

  // ISO: YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) return buildIso(isoMatch[1]!, isoMatch[2]!, isoMatch[3]!);

  // Slash/dash separated: parts depend on `order`.
  const partsMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (partsMatch) {
    const first = partsMatch[1]!;
    const second = partsMatch[2]!;
    const year = expandYear(partsMatch[3]!);
    return order === 'dmy'
      ? buildIso(year, second, first)
      : buildIso(year, first, second); // mdy / ymd both treat first as month-ish
  }

  throw new Error(`Unrecognized date: "${input}"`);
}

function expandYear(year: string): string {
  if (year.length === 4) return year;
  const n = Number(year);
  return String(n >= 70 ? 1900 + n : 2000 + n);
}

function buildIso(year: string, month: string, day: string): string {
  const mm = month.padStart(2, '0');
  const dd = day.padStart(2, '0');
  if (Number(mm) < 1 || Number(mm) > 12) throw new Error(`Invalid month: "${month}"`);
  if (Number(dd) < 1 || Number(dd) > 31) throw new Error(`Invalid day: "${day}"`);
  return `${year}-${mm}-${dd}`;
}
