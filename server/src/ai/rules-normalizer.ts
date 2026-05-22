import { UNCATEGORIZED } from '../domain/categories.js';
import type {
  NormalizationContext,
  NormalizationInput,
  NormalizationResult,
  TransactionNormalizer,
} from './types.js';

/**
 * Deterministic, zero-config baseline. Cleans the merchant string by
 * stripping the boilerplate banks pad descriptions with (POS DEBIT prefixes,
 * transaction IDs, phone numbers, state codes, store numbers), then picks a
 * category either from the bank's own hint or a keyword-rule list.
 *
 * Not as accurate as a real AI provider, but works offline with no setup —
 * the right fallback when AI_PROVIDER=rules (the default).
 */

/** Map Chase's own category names to ours when the bank provides one. */
const CHASE_CATEGORY_MAP: Record<string, string> = {
  'Bills & Utilities': 'Bills & Utilities',
  Entertainment: 'Entertainment',
  'Food & Drink': 'Dining & Restaurants',
  Gas: 'Gas & Fuel',
  Groceries: 'Groceries',
  Travel: 'Travel',
  Shopping: 'Shopping',
  'Health & Wellness': 'Health & Medical',
  'Fees & Adjustments': 'Fees & Charges',
  Personal: 'Personal Care',
  Education: 'Education',
  Home: 'Home',
};

// Order matters — first match wins, so the more-specific patterns go first
// (UBER *ONE MEMBERSHIP must beat UBER → Travel).
const KEYWORD_RULES: Array<{ pattern: RegExp; category: string }> = [
  // Subscriptions
  {
    pattern:
      /\b(NETFLIX|HULU|SPOTIFY|PEACOCK|DISNEY\+|YOUTUBE PREMIUM|APPLE TV|HBO MAX|PARAMOUNT|ADOBE|AMAZON PRIME)\b/i,
    category: 'Subscriptions',
  },
  { pattern: /UBER\s*\*\s*ONE/i, category: 'Subscriptions' },
  // Transfers
  {
    pattern: /\b(TRANSFER|AUTOMATIC PAYMENT|AUTOPAY|ZELLE)\b/i,
    category: 'Transfers',
  },
  // Taxes
  { pattern: /\b(IRS|USATAXPYMT|TAX PAYMENT)\b/i, category: 'Taxes' },
  // Income
  {
    pattern:
      /\b(PAYROLL|DIRECT DEPOSIT|INTEREST PAYMENT|INTEREST EARNED|REIMBURSEMENT)\b/i,
    category: 'Income',
  },
  // Fees
  {
    pattern:
      /\b(INTEREST CHARGE|ANNUAL MEMBERSHIP|OVERDRAFT|LATE FEE|SERVICE CHARGE|STATEMENT CREDIT)\b/i,
    category: 'Fees & Charges',
  },
  // Bills & Utilities
  {
    pattern:
      /\b(T-?MOBILE|VERIZON|AT&T|ATT|SPECTRUM|COMCAST|XFINITY|ONSTAR|ELECTRIC|UTILITY)\b/i,
    category: 'Bills & Utilities',
  },
  // Gas
  {
    pattern:
      /\b(KWIK TRIP|SHELL OIL|EXXON|CHEVRON|MOBIL|SUNOCO|CITGO|MARATHON|BP\s*#|GAS\s*STATION|FUEL)\b/i,
    category: 'Gas & Fuel',
  },
  // Groceries
  {
    pattern:
      /\b(WALMART|KROGER|TRADER JOE|WHOLE FOODS|COSTCO|SAFEWAY|PUBLIX|ALDI|WEGMANS|GROCERY|SUPERMARKET)\b/i,
    category: 'Groceries',
  },
  // Dining
  {
    pattern:
      /\b(STARBUCKS|MCDONALDS|CHIPOTLE|PIZZA|DOORDASH|UBER\s*EATS|GRUBHUB|COFFEE|CAFE|RESTAURANT|BREWERY|DINER)\b/i,
    category: 'Dining & Restaurants',
  },
  // Health
  {
    pattern:
      /\b(WALGREENS|CVS|PHARMACY|DOCTOR|CLINIC|HOSPITAL|DENTAL|OPTOMETRY)\b/i,
    category: 'Health & Medical',
  },
  // Travel
  {
    pattern:
      /\b(UBER|LYFT|AIRLINES|HOTEL|AIRBNB|EXPEDIA|TOLL|CLEAR\s*\*)\b/i,
    category: 'Travel',
  },
  // Entertainment
  {
    pattern: /\b(AMC|REGAL|CINEMA|TICKETMASTER|CONCERT|STEAM POWERED)\b/i,
    category: 'Entertainment',
  },
  // Shopping (broad — checked late)
  {
    pattern: /\b(AMAZON|EBAY|ETSY|BEST\s*BUY|TARGET|PAYPAL|PP\*)\b/i,
    category: 'Shopping',
  },
];

const KNOWN_ACRONYMS = new Set([
  'IRS',
  'USAA',
  'ATT',
  'CVS',
  'AMC',
  'PNC',
  'TD',
  'BP',
  'ACH',
  'POS',
  'CLEAR',
]);

function titleCaseWord(word: string): string {
  if (word.length <= 1) return word;
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

/** Clean a bank's raw description into a presentable merchant name. */
export function cleanMerchant(raw: string): string {
  let s = (raw ?? '').toUpperCase();

  // Strip common Chase-style prefixes.
  s = s.replace(/^POS\s+(DEBIT|PURCHASE)\s+/i, '');
  s = s.replace(/^ORIG\s+CO\s+NAME:\s*/i, '');
  s = s.replace(/^ONLINE\s+TRANSFER\s+(TO|FROM)\s+/i, 'TRANSFER ');

  // Strip ACH/wire metadata tails.
  s = s.replace(
    /\b(WEB ID|ORIG ID|PPD ID|SEC|ENTRY DESCR|CO ENTRY DESCR|TRANSACTION\s*#?):\s*\S+.*$/i,
    '',
  );

  // Strip long transaction ids and phone numbers.
  s = s.replace(/\b\d{10,}\b/g, '');
  s = s.replace(/\b\d{3}-?\d{3}-?\d{4}\b/g, '');

  // Strip store numbers, trailing dates, trailing state codes, web domains.
  s = s.replace(/#\d+\b/g, '');
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/, '');
  s = s.replace(/\s+[A-Z]{2}\s*$/, '');
  s = s.replace(/\.(COM|NET|ORG)\b/gi, '');

  // PP* (PayPal indicator) — strip the prefix.
  s = s.replace(/^PP\s*\*\s*/i, '');

  // For other "*" separators (e.g. CLEAR*CLEARME, TMOBILE*POSTPAID), the
  // first chunk is almost always the brand — keep it.
  if (s.includes('*')) {
    const parts = s
      .split('*')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 1) {
      s = parts[0]!;
    }
  }

  // Collapse whitespace and trailing corporate suffixes.
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+(LLC|INC|CORP|CO|LTD)\.?\s*$/i, '');

  // Drop consecutive duplicate tokens (e.g. "NETFLIX NETFLIX").
  const tokens = s.split(' ');
  s = tokens.filter((t, i) => t !== tokens[i - 1]).join(' ');

  // Title-case while preserving known acronyms.
  const titled = s
    .split(' ')
    .map((word) => {
      if (KNOWN_ACRONYMS.has(word)) return word;
      if (word.includes('-')) {
        return word.split('-').map(titleCaseWord).join('-');
      }
      return titleCaseWord(word);
    })
    .join(' ')
    .trim();

  // Tidy a few common brand renderings.
  const tidied = titled
    .replace(/\bTmobile\b/gi, 'T-Mobile')
    .replace(/\bMcdonald'?s\b/gi, "McDonald's")
    .replace(/\bAt\s*&?\s*T\b/gi, 'AT&T')
    .trim();

  return tidied || (raw ?? '').trim() || 'Unknown';
}

/**
 * High-confidence overrides applied BEFORE the bank's source_category — for
 * the handful of patterns banks consistently mis-label (Chase commonly tags
 * Uber One memberships as "Travel" and streaming as "Entertainment").
 */
const STRONG_OVERRIDES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /UBER\s*\*\s*ONE/i, category: 'Subscriptions' },
  {
    pattern:
      /\b(NETFLIX|HULU|SPOTIFY|DISNEY\+|PEACOCK|HBO MAX|APPLE TV|PARAMOUNT)\b/i,
    category: 'Subscriptions',
  },
  { pattern: /\bADOBE\b/i, category: 'Subscriptions' },
];

/** Choose a category from the allowed set using bank hint + keyword rules. */
export function pickCategory(
  rawDescription: string,
  sourceCategory: string | null,
  allowed: ReadonlySet<string>,
): { category: string; confidence: number } {
  for (const rule of STRONG_OVERRIDES) {
    if (rule.pattern.test(rawDescription) && allowed.has(rule.category)) {
      return { category: rule.category, confidence: 0.85 };
    }
  }
  if (sourceCategory) {
    const mapped = CHASE_CATEGORY_MAP[sourceCategory];
    if (mapped && allowed.has(mapped)) {
      return { category: mapped, confidence: 0.8 };
    }
  }
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(rawDescription) && allowed.has(rule.category)) {
      return { category: rule.category, confidence: 0.7 };
    }
  }
  return { category: UNCATEGORIZED, confidence: 0.2 };
}

export class RulesNormalizer implements TransactionNormalizer {
  readonly id = 'rules';
  readonly name = 'Rules-based (deterministic)';

  async normalize(
    inputs: NormalizationInput[],
    ctx: NormalizationContext,
  ): Promise<NormalizationResult[]> {
    const allowed = new Set<string>(ctx.categories);
    if (!allowed.has(UNCATEGORIZED)) allowed.add(UNCATEGORIZED);

    return inputs.map((input) => {
      const merchant = cleanMerchant(input.rawDescription);
      const { category, confidence } = pickCategory(
        input.rawDescription,
        input.sourceCategory,
        allowed,
      );
      return {
        id: input.id,
        merchant,
        category,
        // The rules engine only ever picks from `allowed`, so there is no
        // unknown category to surface for user validation.
        suggestedCategory: null,
        confidence,
        note: null,
      };
    });
  }
}
