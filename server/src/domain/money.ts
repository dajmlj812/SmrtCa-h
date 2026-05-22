/**
 * Parse a money string into integer cents without ever touching a float.
 * Accepts: "-9.99", "1,419.00", "$2,466.57", "(12.34)" (parens = negative),
 * "12", numbers. Throws on empty or non-numeric input.
 */
export function parseAmountToCents(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`Invalid amount: ${input}`);
    return Math.round(input * 100);
  }

  let s = input.trim();
  if (s === '') throw new Error('Empty amount');

  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') {
    throw new Error(`Invalid amount: "${input}"`);
  }

  const [whole = '0', frac = ''] = s.split('.');
  const fracCents = Number((frac + '00').slice(0, 2));
  const cents = Number(whole || '0') * 100 + fracCents;
  return negative ? -cents : cents;
}

/** Best-effort variant: returns null instead of throwing (e.g. blank balances). */
export function tryParseAmountToCents(
  input: string | number | null | undefined,
): number | null {
  if (input === null || input === undefined) return null;
  try {
    return parseAmountToCents(input);
  } catch {
    return null;
  }
}

/** Format integer cents as a plain decimal string, e.g. -999 -> "-9.99". */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
