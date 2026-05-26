/**
 * 0.19.1 — Built-in bill-negotiation knowledge base.
 *
 * Companion to the 0.18.1 cancellation library. Same shape, same
 * lookup strategy, different intent: instead of "how do I stop
 * paying", these entries answer "how do I pay less without
 * stopping" — retention scripts, dispute URLs, escalation
 * playbooks.
 *
 * Categories covered:
 *   - Cable / fiber internet (Xfinity, Spectrum, Cox, ATT, Verizon,
 *     Frontier, Optimum, T-Mobile Home Internet)
 *   - Mobile carriers (Verizon, ATT, T-Mobile, Mint, Visible,
 *     Cricket, US Cellular)
 *   - Electric / gas (most utilities have a "billing options" path
 *     that offers budget billing, time-of-use rates, low-income
 *     assistance — generic template covers the common ground)
 *   - Insurance (auto + homeowners — discount audits are the lift)
 *
 * Lookup strategy mirrors cancellation-library.ts: normalize to
 * lowercase + strip non-alphanumerics, longest-match wins.
 */

export interface NegotiationEntry {
  /** Matching key (lowercase, alphanumeric only). */
  merchant: string;
  /** Human-readable category for UI grouping. */
  category:
    | 'internet'
    | 'cell'
    | 'electric'
    | 'gas'
    | 'insurance'
    | 'cable_tv'
    | 'other';
  /** Best URL for billing inquiries / rate review. */
  negotiateUrl: string | null;
  /** Canned email template (Subject + body). */
  emailTemplate: string | null;
  /** Markdown step-by-step (phone-script outlines, key phrases). */
  steps: string | null;
  /** Caveats (best time to call, promo windows, rep limits). */
  notes: string | null;
}

const EMAIL_TEMPLATE_RETENTION = `Subject: Account review — exploring lower-cost options

Hello,

I've been a customer for <YEARS> years and want to review my
current plan. I'm specifically interested in:

  1. Any loyalty / retention discount available on my account.
  2. Lower-tier plans that still cover what I actually use.
  3. Any current promotional rates available to existing customers.

Please reply with:
  - The promo / discount the account currently qualifies for
  - The total monthly cost if I move to a lower tier
  - Any contract / commitment associated with each option

Account: <YOUR NAME>, <ACCOUNT NUMBER>

Thank you.`;

const EMAIL_TEMPLATE_BILL_DISPUTE = `Subject: Bill review request — recent statement

Hello,

I'd like a review of my most recent statement. Specifically:

  - <DESCRIBE THE CHARGE — line item, date, amount>

Could you confirm what this charge represents and whether it
matches my plan terms? If it's a one-time fee or a rate change
I wasn't notified of, I'd like to understand what options are
available.

Account: <YOUR NAME>, <ACCOUNT NUMBER>

Thank you.`;

const EMAIL_TEMPLATE_INSURANCE_AUDIT = `Subject: Policy review — discount audit

Hello,

I'd like to review my current policy for available discounts
I may not be on. In particular, please check whether I qualify
for:

  - Multi-policy / bundling discount
  - Paperless billing discount
  - Automatic payment discount
  - Safe-driver / good-student / loyalty discount (auto)
  - New-roof / monitored-alarm discount (home)
  - Annual mileage adjustment (if my commute has changed)

Could you also re-run my premium against my current vehicle /
home / driver list to make sure nothing is out of date?

Policy: <YOUR NAME>, <POLICY NUMBER>

Thank you.`;

const LIBRARY: NegotiationEntry[] = [
  // ── Internet / Cable / TV ────────────────────────────────
  {
    merchant: 'xfinity',
    category: 'internet',
    negotiateUrl: 'https://www.xfinity.com/learn/offers',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      '1. Call 1-800-XFINITY (1-800-934-6489); say "cancel service" at the prompt to route to retention.\n2. State that your promotional rate ended (or that you\'re comparing offers from a competitor).\n3. Ask: "What\'s the lowest rate you can offer me to keep me as a customer?"\n4. Don\'t accept the first offer — ask "is that the best you can do?" once before agreeing.\n5. Get the new monthly total + end date of the new promo in writing (chat transcript or email).',
    notes:
      'Comcast retention has wide latitude — agents can drop $20-40/mo for 12 months. Best time: late afternoon weekdays. Promo cycles every 12 months; set a reminder to re-negotiate before the next renewal.',
  },
  {
    merchant: 'comcast',
    category: 'internet',
    negotiateUrl: 'https://www.xfinity.com/learn/offers',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      'Same as Xfinity. "Comcast" and "Xfinity" are the same company; the consumer brand is Xfinity but billing often still says Comcast.',
    notes: 'See Xfinity entry.',
  },
  {
    merchant: 'spectrum',
    category: 'internet',
    negotiateUrl: 'https://www.spectrum.com/contact-us',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      '1. Call 1-855-243-8892. Direct line to retention.\n2. State you\'re considering switching to a competitor (mention specific provider + price if you have one).\n3. Spectrum offers "promotional pricing for new customers" — ask if any are available for existing customers.\n4. They often add 100 Mbps speed bumps for free as a "thank you for being a long-time customer."',
    notes:
      'Spectrum is stingier than Xfinity on outright discounts but flexible on speed upgrades. Internet-only is usually a better deal than the bundles.',
  },
  {
    merchant: 'cox',
    category: 'internet',
    negotiateUrl: 'https://www.cox.com/residential/contactus.html',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      '1. Call 1-800-234-3993. Say "cancel" to route to retention.\n2. Mention you\'ve had the service for over a year and your promo has ended.\n3. Ask for the "loyalty discount" — Cox names it explicitly.\n4. If denied, ask to schedule cancellation for 30 days out, then call back — frequently retention then calls YOU with a better offer.',
    notes: 'Cox retention often offers a 6-month bridge rate rather than 12. Confirm the promo duration.',
  },
  {
    merchant: 'att',
    category: 'internet',
    negotiateUrl: 'https://www.att.com/support/contact-us/',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      '1. Call 1-800-288-2020. Say "loyalty department" or "cancel service" to route.\n2. AT&T Fiber pricing is usually firm but they\'ll add bonuses (Visa cards, gift cards, free TV add-ons).\n3. Ask explicitly: "Is there a current promotion for existing customers?" They\'ll often miss adding it unless asked.',
    notes:
      'AT&T can apply some mobile-customer discounts to internet billing if you have AT&T mobile. Mention that explicitly.',
  },
  {
    merchant: 'verizonfios',
    category: 'internet',
    negotiateUrl: 'https://www.verizon.com/about/contact-us',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      '1. Call 1-800-VERIZON (1-800-837-4966). Route to "fios" then "billing".\n2. Verizon Fios pricing is often "what you signed up for" — promos are less common than cable.\n3. Best leverage: ask about combined Fios + Verizon mobile discounts.\n4. If you have Verizon mobile, asking about the bundle discount alone can drop $10-20/mo.',
    notes:
      'Fios negotiation is harder than cable. Speed upgrades at the same price are more achievable than rate cuts.',
  },
  {
    merchant: 'optimum',
    category: 'internet',
    negotiateUrl: 'https://www.optimum.com/contact-us',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      'Call 1-866-218-3025. Optimum retention is reasonably flexible — promos cycle every 12 months.',
    notes: 'Altice One pricing has been creeping up; renegotiate annually.',
  },
  {
    merchant: 'tmobilehome',
    category: 'internet',
    negotiateUrl: 'https://www.t-mobile.com/home-internet',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      'T-Mobile Home Internet pricing is flat — they market it as "no contract, no promo cliff." Less negotiation room. If you ALSO have T-Mobile mobile, ask about the bundle discount ($15-25/mo off).',
    notes: 'The bundle discount is the only real lever here.',
  },
  // ── Mobile / Cell ────────────────────────────────────────
  {
    merchant: 'verizonwireless',
    category: 'cell',
    negotiateUrl: 'https://www.verizon.com/support/',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      '1. Call 1-800-922-0204 or use the app chat (often faster, no hold time).\n2. Ask explicitly about: (a) Auto-pay discount if not on it ($10/line); (b) Loyalty discount; (c) Whether moving to a lower-tier "Unlimited Welcome" plan would meet your usage.\n3. Verizon often runs "current customer trade-in" deals on phones that effectively lower bill via device credits.',
    notes:
      'Verizon retention has the LEAST flex of the big 3. Your best lever is moving down a tier, not negotiating the current tier.',
  },
  {
    merchant: 'attwireless',
    category: 'cell',
    negotiateUrl: 'https://www.att.com/support/contact-us/',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      '1. Call 1-800-331-0500.\n2. Ask about "AT&T Signature Program" eligibility (employer / school discount, 15-25% off).\n3. Mention competitor offers — AT&T retention can drop $10-20/line for 12 months.\n4. Auto-pay + paperless = $10/line off; verify both are active.',
    notes:
      'Employer-discount alone can save more than retention pricing — check if your or your spouse\'s employer is on the AT&T Signature list.',
  },
  {
    merchant: 'tmobile',
    category: 'cell',
    negotiateUrl: 'https://www.t-mobile.com/contact-us',
    emailTemplate: EMAIL_TEMPLATE_RETENTION,
    steps:
      '1. Call 611 from a T-Mobile phone, or 1-800-937-8997.\n2. T-Mobile rarely discounts the published plan price; the lever is plan tier (Magenta MAX → Magenta = $20/line/mo savings).\n3. Ask about Insider discount, employer discount, and the 55+ tier if applicable.\n4. Costco / AAA member discounts: 10% off most plans, often missed at signup.',
    notes:
      'T-Mobile pricing is the most transparent of the big 3 — less negotiation room but fewer surprises.',
  },
  {
    merchant: 'mintmobile',
    category: 'cell',
    negotiateUrl: 'https://www.mintmobile.com/help',
    emailTemplate: null,
    steps:
      'Mint pricing is essentially fixed — they advertise the rate publicly. The only "negotiation" lever is buying 12 months upfront vs 3 months (saves ~30%). Set a calendar reminder for the renewal — the first-year promo rate doesn\'t persist.',
    notes:
      'Mint\'s first-year promo expires after 12 months. Many customers see their bill jump 50%+ at renewal — buy another 12-month block at the new-customer rate by canceling + re-signing-up if needed.',
  },
  // ── Electric / Gas / Water ───────────────────────────────
  {
    merchant: 'pge',
    category: 'electric',
    negotiateUrl: 'https://www.pge.com/en_US/residential/customer-service/customer-service.page',
    emailTemplate: EMAIL_TEMPLATE_BILL_DISPUTE,
    steps:
      '1. PG&E rates are regulated, but the BILL can be reduced via:\n   - CARE / FERA income-based assistance (apply at pge.com/care).\n   - Time-of-Use rate plans (often cheaper if you can shift heavy usage off-peak).\n   - Budget Billing (smooths winter spikes — doesn\'t lower total but predictable).\n2. Call 1-800-743-5000 to discuss plan options.\n3. Solar / battery installations + Net Metering are the only real lever for absolute reduction.',
    notes:
      'You cannot negotiate rates with a regulated utility, but you can choose a DIFFERENT regulated plan (TOU, EV, CARE). Audit your plan against the PG&E plan calculator.',
  },
  {
    merchant: 'duke',
    category: 'electric',
    negotiateUrl: 'https://www.duke-energy.com/customer-service',
    emailTemplate: EMAIL_TEMPLATE_BILL_DISPUTE,
    steps:
      'Same as PG&E pattern: rates are regulated, but plan choice + assistance programs + budget billing are levers. Duke has a "Power Manager" program (small monthly credit for letting them cycle A/C during peak demand).',
    notes: 'Regulated utility. Choice of plan, not rate.',
  },
  // ── Insurance ────────────────────────────────────────────
  {
    merchant: 'geico',
    category: 'insurance',
    negotiateUrl: 'https://www.geico.com/contact-us/',
    emailTemplate: EMAIL_TEMPLATE_INSURANCE_AUDIT,
    steps:
      '1. Call 1-800-841-3000 and request a "policy review."\n2. Provide updated mileage if your commute has changed.\n3. Ask explicitly about: multi-policy, paperless, autopay, good-student, defensive-driver, military, federal-employee discounts.\n4. Compare against an independent broker quote every 2 years — Geico\'s renewal rate sometimes drifts above market.',
    notes:
      'Annual auto-rate audit is worth it across all carriers. Geico is competitive but not always cheapest after 2-3 years of "loyalty pricing."',
  },
  {
    merchant: 'progressive',
    category: 'insurance',
    negotiateUrl: 'https://www.progressive.com/contact-us/',
    emailTemplate: EMAIL_TEMPLATE_INSURANCE_AUDIT,
    steps:
      '1. Call 1-800-776-4737.\n2. Snapshot (telematics) discount can save 10-30% if you\'re actually a careful driver.\n3. Name Your Price tool lets you target a monthly budget — they\'ll adjust deductibles/coverage to hit it.\n4. Bundle home + auto for ~10-15%.',
    notes: 'Progressive is aggressive on competitor comparison — they\'ll show you specifically where you\'d pay more elsewhere.',
  },
  {
    merchant: 'statefarm',
    category: 'insurance',
    negotiateUrl: 'https://www.statefarm.com/customer-care',
    emailTemplate: EMAIL_TEMPLATE_INSURANCE_AUDIT,
    steps:
      '1. State Farm operates via local agents — call your agent directly, not the 800 number.\n2. Ask for an "annual policy review."\n3. Drive Safe & Save telematics discount works for safe drivers.\n4. Multi-line discount is meaningful (auto + home + life).',
    notes: 'Agent-based model means your specific agent matters. A new agent / quote from another State Farm office can shift pricing.',
  },
  {
    merchant: 'allstate',
    category: 'insurance',
    negotiateUrl: 'https://www.allstate.com/contact-us',
    emailTemplate: EMAIL_TEMPLATE_INSURANCE_AUDIT,
    steps:
      '1. Call 1-800-255-7828 or your local agent.\n2. Allstate has a "Claim-Free Bonus" that builds over time — confirm it\'s active on your policy.\n3. Drivewise telematics discount.\n4. Bundle discount is substantial; ask if you only have one product with them.',
    notes: 'Renewal rates creep — annual audit recommended.',
  },
];

function normalize(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Look up a negotiation entry by merchant/bill name. Same strategy
 * as cancellation-library.lookupCancellation — normalized longest-
 * match wins.
 */
export function lookupNegotiation(name: string): NegotiationEntry | null {
  const norm = normalize(name);
  if (norm === '') return null;
  let best: NegotiationEntry | null = null;
  let bestLen = 0;
  for (const entry of LIBRARY) {
    if (norm === entry.merchant || norm.includes(entry.merchant)) {
      if (entry.merchant.length > bestLen) {
        best = entry;
        bestLen = entry.merchant.length;
      }
    }
  }
  return best;
}

export const GENERIC_RETENTION_EMAIL = EMAIL_TEMPLATE_RETENTION;
export const GENERIC_BILL_DISPUTE_EMAIL = EMAIL_TEMPLATE_BILL_DISPUTE;
export const GENERIC_INSURANCE_AUDIT_EMAIL = EMAIL_TEMPLATE_INSURANCE_AUDIT;
