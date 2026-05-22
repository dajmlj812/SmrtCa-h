/**
 * Shared building blocks used by both the Claude and Ollama providers — the
 * system prompt, the output JSON schema, and a defensive result-merger that
 * re-aligns the model's response with the original batch.
 */
import { UNCATEGORIZED } from '../domain/categories.js';
import type {
  NormalizationInput,
  NormalizationResult,
} from './types.js';

export interface ParsedResult {
  id: string;
  merchant: string;
  category: string;
  confidence: number;
  note: string;
}

export interface ParsedResponse {
  results: ParsedResult[];
}

/** Encode one batch row as a single user-message line. */
export function encodeBatchLine(t: NormalizationInput, index: number): string {
  return `${index + 1}. id=${JSON.stringify(t.id)} | amount_cents=${t.amountCents} | source_category=${
    t.sourceCategory ? JSON.stringify(t.sourceCategory) : 'null'
  } | raw=${JSON.stringify(t.rawDescription)}`;
}

/**
 * Map the model's results back onto the original batch by id, falling back
 * to a safe default for any input the model dropped or returned junk for.
 */
export function mergeWithBatch(
  batch: NormalizationInput[],
  parsed: ParsedResponse | null,
  allowed: ReadonlySet<string>,
): NormalizationResult[] {
  const byId = new Map(parsed?.results?.map((r) => [r.id, r]) ?? []);
  return batch.map((input) => {
    const r = byId.get(input.id);
    if (!r) {
      return {
        id: input.id,
        merchant: input.rawDescription.slice(0, 200),
        category: UNCATEGORIZED,
        suggestedCategory: null,
        confidence: 0,
        note: 'Missing from model response',
      };
    }
    const rawCat = typeof r.category === 'string' ? r.category.trim() : '';
    const isKnown = rawCat !== '' && allowed.has(rawCat);
    const category = isKnown ? rawCat : UNCATEGORIZED;
    // Capture the AI's raw suggestion when it was something other than a
    // known category — but ignore an empty string or the explicit fallback,
    // both of which mean "I don't know" rather than "here's a new idea."
    const suggestedCategory =
      !isKnown && rawCat !== '' && rawCat.toLowerCase() !== UNCATEGORIZED.toLowerCase()
        ? rawCat
        : null;
    const confidence = Number.isFinite(r.confidence)
      ? Math.max(0, Math.min(1, r.confidence))
      : 0.5;
    const merchant = (r.merchant || input.rawDescription)
      .trim()
      .slice(0, 200);
    const note =
      typeof r.note === 'string' && r.note.trim() !== ''
        ? r.note.trim()
        : null;
    return {
      id: input.id,
      merchant,
      category,
      suggestedCategory,
      confidence,
      note,
    };
  });
}

/** JSON Schema describing the expected response shape — fed to structured-outputs. */
export function buildResponseSchema(categories: readonly string[]): unknown {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'merchant', 'category', 'confidence', 'note'],
          properties: {
            id: {
              type: 'string',
              description: 'The id echoed from the input.',
            },
            merchant: {
              type: 'string',
              description: 'Cleaned, presentable merchant name.',
            },
            category: {
              type: 'string',
              enum: [...categories],
              description: 'Exactly one of the allowed categories.',
            },
            confidence: {
              type: 'number',
              description: 'Confidence in the result, between 0 and 1.',
            },
            note: {
              type: 'string',
              description:
                'Optional explanation. Use an empty string when no note is needed.',
            },
          },
        },
      },
    },
  };
}

/** The full system prompt used by both providers. */
export function buildNormalizerSystemPrompt(
  categories: readonly string[],
): string {
  return SYSTEM_HEADER + categoriesSection(categories) + SYSTEM_EXAMPLES;
}

function categoriesSection(categories: readonly string[]): string {
  return [
    '',
    '## Allowed categories',
    '',
    'You MUST pick one of these exact category names for every transaction.',
    'If none clearly fits, use "Uncategorized" — never invent a category.',
    '',
    ...categories.map((c) => `- ${c}`),
    '',
    '## Category guidance',
    '',
    '- **Income** — paychecks, direct deposits, interest payments, dividends, refunds, reimbursements.',
    '- **Groceries** — supermarkets, grocery stores, food markets (not restaurants).',
    '- **Dining & Restaurants** — restaurants, coffee shops, fast food, food delivery (DoorDash, Uber Eats).',
    '- **Transportation** — public transit, parking, ride-share for everyday commuting (not travel).',
    '- **Gas & Fuel** — gas stations.',
    '- **Shopping** — general retail (Amazon, Target, eBay), online stores, miscellaneous purchases.',
    '- **Entertainment** — movies, concerts, ticketed events, gaming purchases.',
    '- **Bills & Utilities** — phone, internet, electricity, water, gas utility, recurring service bills.',
    '- **Health & Medical** — pharmacies, doctors, dentists, vision, clinics, hospitals.',
    '- **Travel** — hotels, airlines, ride-share for travel, vacation rentals, tolls, travel-related fees.',
    '- **Home** — home improvement, furniture, household supplies.',
    '- **Insurance** — health, auto, home, life insurance premiums.',
    '- **Education** — tuition, books, courses, training, school fees.',
    '- **Personal Care** — barber, salon, gym, spa, cosmetics.',
    '- **Fees & Charges** — bank fees, late fees, interest charges, annual membership fees, overdraft.',
    '- **Subscriptions** — recurring software, media, and service subscriptions (Netflix, Adobe, Uber One).',
    '- **Transfers** — payments between your own accounts, credit-card autopay, Zelle, internal transfers.',
    '- **Taxes** — tax payments to the IRS or state.',
    '- **Gifts & Donations** — charity, donations, gifts to others.',
    '- **Uncategorized** — when the description is too ambiguous to categorize.',
    '',
    '## Output format',
    '',
    'Return strictly JSON in this shape (no preamble, no markdown fences):',
    '',
    '```',
    '{',
    '  "results": [',
    '    { "id": "<echo>", "merchant": "<clean name>", "category": "<one of the allowed>", "confidence": 0.0-1.0, "note": "" }',
    '  ]',
    '}',
    '```',
    '',
    'Return one result per input, in input order.',
    '',
  ].join('\n');
}

const SYSTEM_HEADER = `You are a financial transaction normalizer for a personal-finance application.

Your job, for each raw bank/credit-card transaction:
  1. **Merchant** — return a clean, presentable merchant name.
  2. **Category** — pick exactly one category from the allowed list.
  3. **Confidence** — your self-rated confidence in the result, a number from 0 to 1.
  4. **Note** — optional one-line note (use an empty string when no note is needed).

## Merchant cleaning rules

Strip the boilerplate that banks pad descriptions with:
- "POS DEBIT", "POS PURCHASE", "ORIG CO NAME:" prefixes.
- 10+ digit transaction IDs, phone numbers, store numbers ("#1091"), trailing dates.
- Trailing 2-letter state codes ("WI", "CA").
- ".COM"/".NET" domain suffixes from merchant names.
- "PP*" PayPal indicator prefix.
- ACH/wire metadata after "WEB ID:", "ORIG ID:", "PPD ID:", "ENTRY DESCR:", "TRANSACTION#:".
- Corporate suffixes (LLC, INC, CORP) at the end.

Render the result in normal case (e.g. "T-Mobile", not "TMOBILE"). Preserve
established brand renderings ("AT&T", "McDonald's", "Uber Eats").

## Category-selection rules

- If the bank provided a \`source_category\`, treat it as a hint — usually
  reliable, but override it when the description clearly indicates otherwise
  (Chase often labels recurring streaming charges under "Entertainment" when
  "Subscriptions" is more accurate).
- "Uber One" / "Uber Pass" memberships → **Subscriptions**, not Travel.
- Streaming services (Netflix, Hulu, Disney+, Spotify, Peacock, Apple TV) →
  **Subscriptions**, not Entertainment.
- Software subscriptions (Adobe, Microsoft 365) → **Subscriptions**.
- Internal transfers, credit-card autopay, Zelle → **Transfers**.
- IRS, state tax payments → **Taxes**.
- Interest charges and annual fees → **Fees & Charges**.
- Payroll deposits, interest payments earned → **Income**.`;

const SYSTEM_EXAMPLES = `
## Worked examples

These show the kind of output expected. Apply the same reasoning to inputs
you have not seen before.

raw="POS DEBIT TMOBILE*POSTPAID PDA 800-937-8997 WA"
amount=-3314, source_category=null
→ merchant: "T-Mobile"
→ category: "Bills & Utilities"
→ confidence: 0.95
→ note: ""

raw="UBER   *ONE MEMBERSHIP"
amount=-999, source_category="Travel"
→ merchant: "Uber One"
→ category: "Subscriptions"
→ confidence: 0.95
→ note: "Bank labeled this Travel but recurring 'Uber One' membership is a subscription"

raw="POS DEBIT NETFLIX.COM NETFLIX.COM CA"
amount=-2847, source_category="Entertainment"
→ merchant: "Netflix"
→ category: "Subscriptions"
→ confidence: 0.98
→ note: ""

raw="ADOBE  *800-833-6687"
amount=-699, source_category="Shopping"
→ merchant: "Adobe"
→ category: "Subscriptions"
→ confidence: 0.95
→ note: ""

raw="POS DEBIT Spectrum 855-707-7328 MO"
amount=-8220, source_category=null
→ merchant: "Spectrum"
→ category: "Bills & Utilities"
→ confidence: 0.95
→ note: ""

raw="KWIK TRIP #1091 PLEASANT PRAI WI"
amount=-1494, source_category=null
→ merchant: "Kwik Trip"
→ category: "Gas & Fuel"
→ confidence: 0.9
→ note: ""

raw="WALGREENS STORE 3805 8 KENOSHA WI"
amount=-837, source_category=null
→ merchant: "Walgreens"
→ category: "Health & Medical"
→ confidence: 0.95
→ note: ""

raw="STARBUCKS STORE 12345 SEATTLE WA"
amount=-525, source_category="Food & Drink"
→ merchant: "Starbucks"
→ category: "Dining & Restaurants"
→ confidence: 0.97
→ note: ""

raw="AUTOMATIC PAYMENT - THANK"
amount=141900, source_category=null
→ merchant: "Credit Card Payment"
→ category: "Transfers"
→ confidence: 0.9
→ note: "Credit-card autopay credit"

raw="PURCHASE INTEREST CHARGE"
amount=-78205, source_category="Fees & Adjustments"
→ merchant: "Interest Charge"
→ category: "Fees & Charges"
→ confidence: 0.98
→ note: ""

raw="ANNUAL MEMBERSHIP FEE"
amount=-9500, source_category="Fees & Adjustments"
→ merchant: "Annual Membership Fee"
→ category: "Fees & Charges"
→ confidence: 0.98
→ note: ""

raw="STATEMENT CREDIT"
amount=835, source_category="Fees & Adjustments"
→ merchant: "Statement Credit"
→ category: "Fees & Charges"
→ confidence: 0.9
→ note: ""

raw="ONLINE TRANSFER TO SAV ...3107 TRANSACTION#: 29318588430 05/22"
amount=-9953, source_category=null
→ merchant: "Transfer to Savings"
→ category: "Transfers"
→ confidence: 0.97
→ note: ""

raw="ONLINE TRANSFER FROM CHK ...5793 TRANSACTION#: 29318588430"
amount=9953, source_category=null
→ merchant: "Transfer from Checking"
→ category: "Transfers"
→ confidence: 0.97
→ note: ""

raw="CHASE CREDIT CRD AUTOPAY                    PPD ID: 4760039224"
amount=-141900, source_category=null
→ merchant: "Chase Credit Card Autopay"
→ category: "Transfers"
→ confidence: 0.95
→ note: ""

raw="ZELLE PAYMENT FROM JANE DOE 29222130672"
amount=5000, source_category=null
→ merchant: "Zelle from Jane Doe"
→ category: "Transfers"
→ confidence: 0.9
→ note: ""

raw="IRS              USATAXPYMT 222650344221142 WEB ID: 3387702000"
amount=-1000000, source_category=null
→ merchant: "IRS"
→ category: "Taxes"
→ confidence: 0.99
→ note: "Federal tax payment"

raw="ORIG CO NAME:RJW LOGISTICS LL CO ENTRY DESCR:PAYROLL    SEC:PPD"
amount=246657, source_category=null
→ merchant: "RJW Logistics Payroll"
→ category: "Income"
→ confidence: 0.95
→ note: ""

raw="INTEREST PAYMENT"
amount=25, source_category=null
→ merchant: "Interest Payment"
→ category: "Income"
→ confidence: 0.95
→ note: ""

raw="IL TOLLWAY-AUTOREPLEN 800-824-7277 IL"
amount=-5000, source_category=null
→ merchant: "Illinois Tollway"
→ category: "Travel"
→ confidence: 0.9
→ note: ""

raw="CLEAR *CLEARME.COM"
amount=-20900, source_category="Personal"
→ merchant: "CLEAR"
→ category: "Travel"
→ confidence: 0.85
→ note: "Airport-security membership"

raw="AMAZON.COM*M1234ABCD AMZN.COM/BILL WA"
amount=-2999, source_category="Shopping"
→ merchant: "Amazon"
→ category: "Shopping"
→ confidence: 0.95
→ note: ""
`;
