/**
 * 0.21.0 — Schedule C line mapping + TXF (Tax eXchange Format) export.
 *
 * The `tax_category` column on categories is free-text by design
 * (see migration 025). For a Schedule C grouping we need a way to
 * identify which user-defined tax_category corresponds to which
 * Schedule C line. We accept three matching strategies, in order:
 *
 *   1. Exact match against SCHEDULE_C_CANON labels.
 *   2. Prefix match "Schedule C - Line N" (case-insensitive).
 *   3. Substring keyword match (e.g. "advertising" → line 8).
 *
 * Anything that matches none lands in an "Other (uncategorized
 * Schedule C)" bucket, signaling to the user that the tax_category
 * label needs tightening for the next return.
 */

export interface ScheduleCLine {
  /** Schedule C line number, e.g. "1", "8", "9". */
  line: string;
  /** Human label for the line as it appears on the IRS form. */
  label: string;
  /** TXF v042 record code for TurboTax import. */
  txfCode: number;
  /** Sign convention: income lines are 'income', deductions are 'expense'. */
  kind: 'income' | 'expense';
  /** Keywords (lowercased) that map a free-text tax_category to this line. */
  keywords: string[];
}

/**
 * Subset of Schedule C lines we generate exports for. Adding lines
 * is intentionally low-risk: extend this array, no other code
 * changes needed.
 *
 * TXF codes are from the TurboTax TXF Standard reference. They
 * are valid for tax years 2020 onward; older years may differ.
 */
export const SCHEDULE_C_LINES: readonly ScheduleCLine[] = [
  { line: '1', label: 'Gross receipts or sales', txfCode: 593, kind: 'income',
    keywords: ['gross receipts', 'sales', 'business income', 'gig income'] },
  { line: '2', label: 'Returns and allowances', txfCode: 591, kind: 'expense',
    keywords: ['returns', 'allowances'] },
  { line: '8', label: 'Advertising', txfCode: 524, kind: 'expense',
    keywords: ['advertising', 'marketing', 'ads'] },
  { line: '9', label: 'Car and truck expenses', txfCode: 525, kind: 'expense',
    keywords: ['car', 'truck', 'mileage', 'vehicle', 'gas', 'fuel'] },
  { line: '10', label: 'Commissions and fees', txfCode: 526, kind: 'expense',
    keywords: ['commissions', 'fees'] },
  { line: '11', label: 'Contract labor', txfCode: 527, kind: 'expense',
    keywords: ['contract labor', '1099', 'subcontractor'] },
  { line: '12', label: 'Depletion', txfCode: 528, kind: 'expense',
    keywords: ['depletion'] },
  { line: '13', label: 'Depreciation', txfCode: 529, kind: 'expense',
    keywords: ['depreciation'] },
  { line: '14', label: 'Employee benefit programs', txfCode: 530, kind: 'expense',
    keywords: ['benefits', 'health insurance', 'employee benefit'] },
  { line: '15', label: 'Insurance (other than health)', txfCode: 531, kind: 'expense',
    keywords: ['insurance'] },
  { line: '16a', label: 'Mortgage interest', txfCode: 532, kind: 'expense',
    keywords: ['mortgage interest'] },
  { line: '16b', label: 'Other interest', txfCode: 533, kind: 'expense',
    keywords: ['interest paid', 'interest expense'] },
  { line: '17', label: 'Legal and professional services', txfCode: 534, kind: 'expense',
    keywords: ['legal', 'professional', 'accountant', 'cpa', 'lawyer'] },
  { line: '18', label: 'Office expense', txfCode: 535, kind: 'expense',
    keywords: ['office', 'office expense'] },
  { line: '19', label: 'Pension and profit-sharing plans', txfCode: 536, kind: 'expense',
    keywords: ['pension', 'profit-sharing', 'sep-ira', 'solo 401'] },
  { line: '20a', label: 'Rent — vehicles, machinery, equipment', txfCode: 537, kind: 'expense',
    keywords: ['equipment rent', 'machinery rent'] },
  { line: '20b', label: 'Rent — other business property', txfCode: 538, kind: 'expense',
    keywords: ['rent', 'office rent'] },
  { line: '21', label: 'Repairs and maintenance', txfCode: 539, kind: 'expense',
    keywords: ['repairs', 'maintenance'] },
  { line: '22', label: 'Supplies', txfCode: 540, kind: 'expense',
    keywords: ['supplies'] },
  { line: '23', label: 'Taxes and licenses', txfCode: 541, kind: 'expense',
    keywords: ['taxes', 'licenses', 'license fee'] },
  { line: '24a', label: 'Travel', txfCode: 542, kind: 'expense',
    keywords: ['travel', 'airfare', 'lodging', 'hotel'] },
  { line: '24b', label: 'Meals (deductible portion)', txfCode: 543, kind: 'expense',
    keywords: ['meals', 'business meals'] },
  { line: '25', label: 'Utilities', txfCode: 544, kind: 'expense',
    keywords: ['utilities', 'phone', 'internet'] },
  { line: '26', label: 'Wages', txfCode: 545, kind: 'expense',
    keywords: ['wages', 'salaries', 'payroll'] },
  { line: '27a', label: 'Other expenses', txfCode: 546, kind: 'expense',
    keywords: ['other expense', 'misc business'] },
];

/**
 * Map a free-text tax_category string to a Schedule C line, or
 * null if no match.
 */
export function matchScheduleCLine(taxCategory: string): ScheduleCLine | null {
  const norm = taxCategory.trim().toLowerCase();
  if (!norm) return null;

  // Strategy 1 — explicit "schedule c - line N" prefix.
  const lineMatch = norm.match(/schedule\s*c[\s\-:]+line\s*(\d+[a-z]?)/);
  if (lineMatch) {
    const found = SCHEDULE_C_LINES.find((l) => l.line === lineMatch[1]);
    if (found) return found;
  }

  // Strategy 2 — exact-label match.
  for (const line of SCHEDULE_C_LINES) {
    if (norm === line.label.toLowerCase()) return line;
  }

  // Strategy 3 — keyword substring.
  for (const line of SCHEDULE_C_LINES) {
    for (const kw of line.keywords) {
      if (norm.includes(kw)) return line;
    }
  }

  return null;
}

/**
 * Build a TXF v042 document body. Each row is a (line, amount)
 * grouping. Caller is responsible for sign conventions: income
 * positive, deductions positive (TXF rates amounts unsigned and
 * relies on the code to know direction).
 *
 * TXF format reference (simplified):
 *
 *   V042              — version
 *   ASmrtCash         — application
 *   D<MM/DD/YYYY>     — export date
 *   ^
 *   TD                — transaction detail record
 *   N<code>           — TXF reference code
 *   C1                — copy number (form 1)
 *   L1                — sub-line (always 1 unless multi-copy)
 *   $<amount>         — amount (decimal, no commas)
 *   P<description>    — payer / payee description
 *   ^
 *   ...
 */
export interface TxfEntry {
  txfCode: number;
  amount: number;
  description: string;
}

export function buildTxf(
  entries: readonly TxfEntry[],
  exportDate: Date = new Date(),
): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const d = `${pad(exportDate.getMonth() + 1)}/${pad(exportDate.getDate())}/${exportDate.getFullYear()}`;
  const lines: string[] = [
    'V042',
    'ASmrtCash',
    `D${d}`,
    '^',
  ];
  for (const e of entries) {
    lines.push('TD');
    lines.push(`N${e.txfCode}`);
    lines.push('C1');
    lines.push('L1');
    lines.push(`$${e.amount.toFixed(2)}`);
    lines.push(`P${e.description.replace(/[\r\n]+/g, ' ')}`);
    lines.push('^');
  }
  // TXF expects CRLF line endings.
  return lines.join('\r\n') + '\r\n';
}
