/**
 * Pluggable receipt-OCR layer — mirrors the TransactionNormalizer pattern so
 * different vision providers (cloud, local, none) can be swapped via config.
 */

export interface OcrInput {
  /** The raw file bytes — image or PDF. */
  buffer: Buffer;
  /** One of the attachment MIME-types: image/jpeg, image/png, image/webp, application/pdf. */
  mimeType: string;
  /** Original filename, used only for logging / hinting. */
  filename: string;
}

export interface OcrResult {
  /** Final total in integer cents. Null when not visible / not confident. */
  amountCents: number | null;
  /** Transaction date in ISO YYYY-MM-DD. Null when not visible. */
  date: string | null;
  /** Primary merchant/vendor name. Null when not visible. */
  merchant: string | null;
  /** 0..1 self-rated confidence in the extraction. */
  confidence: number;
  /** Optional one-line note (e.g. "subtotal only, tax not shown"). */
  note: string | null;
}

export interface OcrProvider {
  /** Stable provider id (e.g. 'claude'). Persisted to attachments.ocr_provider. */
  readonly id: string;
  /** Human-readable name (e.g. 'Claude API (vision)'). */
  readonly name: string;
  /** Run extraction on one file. Implementations should throw on hard failure. */
  extract(input: OcrInput): Promise<OcrResult>;
}
