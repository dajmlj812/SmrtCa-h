/**
 * Stable system prompt + JSON schema used by every OCR provider. Kept here
 * so multiple providers (Claude today, Ollama-vision later) can share the
 * exact same contract.
 */

export const OCR_SYSTEM_PROMPT = `You are a receipt OCR assistant for a personal finance application.
Extract the following details from the receipt or invoice image/PDF:

1. **amountCents** — the FINAL total amount paid, in cents (integer).
   - Examples: $12.34 → 1234. $1,234.56 → 123456.
   - Use the "TOTAL" or "GRAND TOTAL" line (NOT "subtotal"). Include tax and
     tip if shown. Use the printed final number, not your own arithmetic.
   - Return null if no total is visible.

2. **date** — the transaction date in YYYY-MM-DD.
   - Use the receipt's printed transaction date. If only a print date is
     visible (no separate transaction date), use that.
   - Return null if no date is visible.

3. **merchant** — the primary business or vendor name.
   - Use the most prominent business name (typically at the top of the receipt).
   - Do NOT include the street address, phone number, or website URL.
   - Examples: "Starbucks", "T-Mobile", "Walmart Supercenter".
   - Return null if no clear merchant is visible.

4. **confidence** — your self-rated confidence in the extraction, 0..1.
   - Lower the score whenever any field is hard to read, blurry, or ambiguous.

5. **note** — optional one-line observation (e.g. "subtotal only, tax not shown",
   "partial receipt", "handwritten amount"). Use an empty string when there is
   nothing notable.

Return strictly the JSON matching the schema — no preamble, no markdown fences.`;

/** JSON schema fed to Claude's structured-outputs (output_config.format). */
export function buildOcrSchema(): unknown {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['amountCents', 'date', 'merchant', 'confidence', 'note'],
    properties: {
      amountCents: {
        anyOf: [{ type: 'integer' }, { type: 'null' }],
        description:
          'Final total in cents. $12.34 → 1234. Null if not visible.',
      },
      date: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Transaction date in YYYY-MM-DD. Null if not visible.',
      },
      merchant: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Primary business name. Null if not visible.',
      },
      confidence: {
        type: 'number',
        description: 'Confidence in the extraction, 0..1.',
      },
      note: {
        type: 'string',
        description: 'Optional observation. Empty string when not needed.',
      },
    },
  };
}

/**
 * Validate and clean a raw OCR payload (anything from a model that wasn't
 * guaranteed valid). Returns a well-formed OcrResult, falling back to null
 * for any field that doesn't pass validation.
 */
export function sanitizeOcrResult(raw: {
  amountCents?: unknown;
  date?: unknown;
  merchant?: unknown;
  confidence?: unknown;
  note?: unknown;
}): {
  amountCents: number | null;
  date: string | null;
  merchant: string | null;
  confidence: number;
  note: string | null;
} {
  const amountCents = sanitizeAmount(raw.amountCents);
  const date = sanitizeDate(raw.date);
  const merchant = sanitizeMerchant(raw.merchant);
  const confidence = Number.isFinite(raw.confidence as number)
    ? Math.max(0, Math.min(1, raw.confidence as number))
    : 0;
  const note =
    typeof raw.note === 'string' && raw.note.trim() !== ''
      ? raw.note.trim().slice(0, 500)
      : null;
  return { amountCents, date, merchant, confidence, note };
}

function sanitizeAmount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return Math.round(value);
}

function sanitizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const yyyy = m[1]!;
  const mm = m[2]!.padStart(2, '0');
  const dd = m[3]!.padStart(2, '0');
  if (Number(mm) < 1 || Number(mm) > 12) return null;
  if (Number(dd) < 1 || Number(dd) > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function sanitizeMerchant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, 200);
}
