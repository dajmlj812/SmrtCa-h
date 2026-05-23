/**
 * Rules-based recurring-transaction detection.
 *
 * Strategy:
 *
 * 1. Bucket transactions by a normalized key (cleaned merchant or first
 *    N chars of raw_description) + sign of amount. Money flowing OUT
 *    on the same key is a candidate bill; money flowing IN is a
 *    candidate income.
 *
 * 2. For each bucket with >= MIN_OCCURRENCES rows, sort by date and
 *    compute the gaps between consecutive entries. The MEAN gap (in
 *    days) classifies the cadence; the VARIANCE of the gaps drives
 *    confidence (tight intervals are more obviously recurring than
 *    erratic ones).
 *
 * 3. Cadence buckets:
 *      mean ~7  ± 2  → weekly
 *      mean ~14 ± 2  → biweekly
 *      mean ~15 ± 3  → semimonthly  (twice a month — slightly wider band)
 *      mean ~30 ± 5  → monthly
 *      mean ~365 ± 30 → yearly
 *      otherwise      → unknown (still surface, but low confidence)
 *
 * Confidence is a 0..1 score that combines variance-tightness with the
 * number of occurrences (more samples = more trust).
 */

export interface RecurringInput {
  id: string;
  date: string; // YYYY-MM-DD
  amount_cents: number;
  normalized_merchant: string | null;
  raw_description: string;
}

export type DetectedFrequency =
  | 'weekly'
  | 'biweekly'
  | 'semimonthly'
  | 'monthly'
  | 'yearly'
  | 'one-time'
  | 'unknown';

export interface RecurringSuggestion {
  kind: 'bill' | 'income';
  name: string;
  normalizedKey: string;
  amountCents: number;
  detectedFrequency: DetectedFrequency;
  /** Up to 5 most-recent sample transaction ids (newest first). */
  sampleTxnIds: string[];
  /** 0..1, three decimal places. */
  confidence: number;
}

const MIN_OCCURRENCES = 3;
const MAX_SAMPLES = 5;

function normalizeKey(input: RecurringInput): string {
  const base =
    (input.normalized_merchant ?? input.raw_description ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  return base || 'UNKNOWN';
}

function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number) as [number, number, number];
  const [yb, mb, db] = b.split('-').map(Number) as [number, number, number];
  const ta = Date.UTC(ya, ma - 1, da);
  const tb = Date.UTC(yb, mb - 1, db);
  return Math.round((tb - ta) / (1000 * 60 * 60 * 24));
}

interface CadenceMatch {
  frequency: DetectedFrequency;
  /** How tightly the mean gap fits this cadence's center — 0..1. */
  cadenceFit: number;
}

const CADENCE_BANDS: Array<{
  frequency: DetectedFrequency;
  center: number;
  width: number;
}> = [
  { frequency: 'weekly', center: 7, width: 2 },
  { frequency: 'biweekly', center: 14, width: 2 },
  { frequency: 'semimonthly', center: 15, width: 3 },
  { frequency: 'monthly', center: 30, width: 5 },
  { frequency: 'yearly', center: 365, width: 30 },
];

function classifyCadence(meanGap: number): CadenceMatch {
  for (const band of CADENCE_BANDS) {
    const dist = Math.abs(meanGap - band.center);
    if (dist <= band.width) {
      return {
        frequency: band.frequency,
        cadenceFit: 1 - dist / band.width,
      };
    }
  }
  return { frequency: 'unknown', cadenceFit: 0 };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function stddev(values: number[], mu: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

interface Bucket {
  key: string;
  kind: 'bill' | 'income';
  rows: RecurringInput[];
}

function bucketise(rows: RecurringInput[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const r of rows) {
    if (r.amount_cents === 0) continue;
    const kind: 'bill' | 'income' = r.amount_cents < 0 ? 'bill' : 'income';
    const key = normalizeKey(r);
    const bucketKey = `${kind}:${key}`;
    let bucket = map.get(bucketKey);
    if (!bucket) {
      bucket = { key, kind, rows: [] };
      map.set(bucketKey, bucket);
    }
    bucket.rows.push(r);
  }
  return Array.from(map.values());
}

export function detectRecurring(
  transactions: RecurringInput[],
): RecurringSuggestion[] {
  const buckets = bucketise(transactions);
  const out: RecurringSuggestion[] = [];

  for (const bucket of buckets) {
    if (bucket.rows.length < MIN_OCCURRENCES) continue;

    // Sort oldest → newest so gaps are positive.
    const sorted = [...bucket.rows].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(daysBetween(sorted[i - 1]!.date, sorted[i]!.date));
    }
    if (gaps.length === 0) continue;

    const meanGap = mean(gaps);
    const stdGap = stddev(gaps, meanGap);
    const cadence = classifyCadence(meanGap);

    // Variance tightness: 1 when stddev is 0, decays with stddev / mean.
    const varianceTightness =
      meanGap === 0 ? 0 : Math.max(0, 1 - stdGap / meanGap);
    // Sample bonus: 3 occurrences → 0.6, 6 → 0.9, plateaus.
    const sampleBonus = Math.min(1, 0.2 + (sorted.length - MIN_OCCURRENCES) * 0.15);
    const confidence = round3(
      0.3 * cadence.cadenceFit + 0.45 * varianceTightness + 0.25 * sampleBonus,
    );

    // Amount: use the median of absolute amounts (resists outliers).
    const absAmounts = sorted
      .map((r) => Math.abs(r.amount_cents))
      .sort((a, b) => a - b);
    const median =
      absAmounts.length % 2 === 1
        ? absAmounts[(absAmounts.length - 1) / 2]!
        : Math.round(
            (absAmounts[absAmounts.length / 2 - 1]! +
              absAmounts[absAmounts.length / 2]!) /
              2,
          );

    const newest = [...sorted].reverse().slice(0, MAX_SAMPLES);
    const name = displayName(newest[0]!);

    out.push({
      kind: bucket.kind,
      name,
      normalizedKey: bucket.key,
      amountCents: median,
      detectedFrequency: cadence.frequency,
      sampleTxnIds: newest.map((r) => r.id),
      confidence,
    });
  }

  // Strongest first.
  return out.sort((a, b) => b.confidence - a.confidence);
}

function displayName(row: RecurringInput): string {
  return (
    row.normalized_merchant ??
    row.raw_description.split(/\s{2,}|—/)[0] ??
    row.raw_description
  ).trim();
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
