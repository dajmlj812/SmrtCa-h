/**
 * 0.21.x — pre-built goal templates the user can drop in instead of
 * typing a name and target from scratch.
 *
 * Each template's `text` contains named placeholders like
 * {amount}, {months}, {years}, {pct}, {count}, {age}. Whatever
 * placeholders appear become input fields in the picker; the
 * filled-in text becomes the goal name. The picker also derives
 * targetAmountCents from {amount} and targetDate from {months} /
 * {years} / {age} so the goal lands with a tracked target.
 */

export type Placeholder = 'amount' | 'months' | 'years' | 'pct' | 'count' | 'age';

export interface GoalTemplate {
  id: number;
  category: string;
  text: string;
  /** Sensible per-placeholder defaults. */
  defaults?: Partial<Record<Placeholder, number>>;
  /**
   * Override the goal-name format independently of the prompt
   * text. Useful when the prompt reads naturally but the stored
   * goal name should be shorter. Same placeholders.
   */
  nameTemplate?: string;
}

export const GOAL_TEMPLATES: readonly GoalTemplate[] = [
  { id: 1, category: 'Emergency fund',
    text: 'Save ${amount} for an emergency fund within {months} months',
    defaults: { amount: 5000, months: 12 } },
  { id: 2, category: 'Debt',
    text: 'Pay off all credit card debt within {months} months',
    defaults: { months: 18 } },
  { id: 3, category: 'Retirement',
    text: 'Increase retirement contributions to {pct}% of income',
    defaults: { pct: 15 } },
  { id: 4, category: 'Home',
    text: 'Save ${amount} for a home down payment in {years} years',
    defaults: { amount: 60000, years: 5 } },
  { id: 5, category: 'Budget',
    text: 'Reduce monthly expenses by ${amount} through budget optimization',
    defaults: { amount: 500 } },
  { id: 6, category: 'Education',
    text: 'Start a 529 college savings plan with ${amount} monthly contributions',
    defaults: { amount: 250 } },
  { id: 7, category: 'Emergency fund',
    text: 'Build a six-month living expense fund by the end of next year',
    defaults: { months: 18 } },
  { id: 8, category: 'Net worth',
    text: 'Increase net worth by {pct}% in the next {months} months',
    defaults: { pct: 20, months: 12 } },
  { id: 9, category: 'Passive income',
    text: 'Develop three streams of passive income within {years} years',
    defaults: { years: 5 } },
  { id: 10, category: 'Debt',
    text: 'Pay off student loans completely within {years} years',
    defaults: { years: 7 } },
  { id: 11, category: 'Lifestyle',
    text: 'Save ${amount} for a dream vacation within {months} months',
    defaults: { amount: 5000, months: 18 } },
  { id: 12, category: 'Credit',
    text: 'Increase credit score above {count} within {months} months',
    defaults: { count: 750, months: 12 } },
  { id: 13, category: 'Investing',
    text: 'Purchase first investment property within {years} years',
    defaults: { years: 5 } },
  { id: 14, category: 'Debt',
    text: 'Reduce debt-to-income ratio below {pct}% within {months} months',
    defaults: { pct: 36, months: 18 } },
  { id: 15, category: 'Education',
    text: "Save enough to cover children's college education by age {age}",
    defaults: { age: 18 } },
  { id: 16, category: 'Business',
    text: 'Start a business with ${amount} in startup capital within {years} years',
    defaults: { amount: 25000, years: 3 } },
  { id: 17, category: 'Income',
    text: 'Increase annual income by {pct}% through career growth or side hustles',
    defaults: { pct: 15 } },
  { id: 18, category: 'Investing',
    text: 'Build an investment portfolio worth ${amount} within {years} years',
    defaults: { amount: 250000, years: 10 } },
  { id: 19, category: 'Savings rate',
    text: 'Achieve a savings rate of {pct}% of take-home pay',
    defaults: { pct: 20 } },
  { id: 20, category: 'Home',
    text: 'Pay off mortgage {years} years early through extra principal payments',
    defaults: { years: 5 } },
  { id: 21, category: 'Budget',
    text: 'Create and maintain a detailed monthly budget for one full year',
    defaults: { months: 12 } },
  { id: 22, category: 'Home',
    text: 'Save ${amount} for home renovations within {months} months',
    defaults: { amount: 15000, months: 18 } },
  { id: 23, category: 'Estate',
    text: 'Develop a comprehensive estate plan (will + trusts) within {months} months',
    defaults: { months: 6 } },
  { id: 24, category: 'Investing',
    text: 'Build a dividend portfolio paying ${amount} monthly within {years} years',
    defaults: { amount: 500, years: 7 } },
  { id: 25, category: 'Retirement',
    text: 'Max out IRA contributions every year for the next {years} years',
    defaults: { years: 10 } },
  { id: 26, category: 'Vehicle',
    text: 'Save ${amount} for a new car down payment within {months} months',
    defaults: { amount: 5000, months: 12 } },
  { id: 27, category: 'Budget',
    text: 'Reduce impulse spending by {pct}% in the next {months} months',
    defaults: { pct: 50, months: 6 } },
  { id: 28, category: 'Retirement',
    text: 'Create a plan to allow for early retirement at age {age}',
    defaults: { age: 55 } },
  { id: 29, category: 'Health',
    text: 'Build a health savings account (HSA) to ${amount} within {years} years',
    defaults: { amount: 10000, years: 5 } },
  { id: 30, category: 'Home',
    text: 'Achieve {pct}% equity in home ownership within {years} years',
    defaults: { pct: 50, years: 7 } },
  { id: 31, category: 'Business',
    text: 'Grow a side business earning ${amount} monthly within {months} months',
    defaults: { amount: 1000, months: 18 } },
  { id: 32, category: 'Education',
    text: 'Create a ${amount} education fund for professional development',
    defaults: { amount: 5000 } },
  { id: 33, category: 'Budget',
    text: 'Pay cash for all major purchases for one full year',
    defaults: { months: 12 } },
  { id: 34, category: 'Lifestyle',
    text: 'Save enough to take a sabbatical from work within {years} years',
    defaults: { years: 5, amount: 30000 } },
  { id: 35, category: 'Investing',
    text: 'Diversify investment portfolio across {count} different asset classes',
    defaults: { count: 5 } },
  { id: 36, category: 'Budget',
    text: 'Reduce fixed monthly expenses to less than {pct}% of take-home pay',
    defaults: { pct: 50 } },
  { id: 37, category: 'Lifestyle',
    text: 'Save ${amount} for a wedding within {years} years',
    defaults: { amount: 30000, years: 2 } },
  { id: 38, category: 'Giving',
    text: 'Donate {pct}% of income to charitable causes',
    defaults: { pct: 10 } },
  { id: 39, category: 'Debt',
    text: 'Eliminate all non-mortgage debt within {years} years',
    defaults: { years: 3 } },
  { id: 40, category: 'Business',
    text: 'Build a ${amount} fund for starting a small business',
    defaults: { amount: 25000 } },
  { id: 41, category: 'Family',
    text: 'Save enough to help elderly parents with long-term care costs',
    defaults: { amount: 50000, years: 5 } },
  { id: 42, category: 'Insurance',
    text: 'Increase insurance coverage to adequately protect family and assets',
    defaults: { months: 6 } },
  { id: 43, category: 'Investing',
    text: 'Create a specific investment fund for each major life goal',
    defaults: { months: 12 } },
  { id: 44, category: 'Tax',
    text: 'Save ${amount} monthly in tax-advantaged accounts',
    defaults: { amount: 1000 } },
  { id: 45, category: 'Housing',
    text: 'Reduce housing costs to less than {pct}% of monthly income',
    defaults: { pct: 30 } },
  { id: 46, category: 'Vehicle',
    text: 'Build a ${amount} fund for future vehicle replacements',
    defaults: { amount: 20000 } },
  { id: 47, category: 'Retirement',
    text: 'Create a sustainable plan for early semi-retirement',
    defaults: { years: 10 } },
  { id: 48, category: 'Net worth',
    text: 'Build wealth allowing for generational wealth transfer to children',
    defaults: { amount: 1000000, years: 20 } },
  { id: 49, category: 'Lifestyle',
    text: 'Save enough to fund a year of travel and experiences within {years} years',
    defaults: { amount: 50000, years: 3 } },
  { id: 50, category: 'Independence',
    text: 'Develop a plan for complete financial independence by age {age}',
    defaults: { age: 50 } },
];

/** Which placeholders appear in a template's text. */
export function placeholdersOf(t: GoalTemplate): Placeholder[] {
  const found = new Set<Placeholder>();
  for (const m of t.text.matchAll(/\{(amount|months|years|pct|count|age)\}/g)) {
    found.add(m[1] as Placeholder);
  }
  return Array.from(found);
}

export interface BuildResult {
  name: string;
  targetAmountCents: number;
  targetDate: string | null;
}

/**
 * Substitute the user's values into the template and derive
 * targetAmountCents + targetDate.
 */
export function buildGoalFromTemplate(
  t: GoalTemplate,
  values: Partial<Record<Placeholder, number>>,
): BuildResult {
  const subbed = (t.nameTemplate ?? t.text).replace(
    /\{(amount|months|years|pct|count|age)\}/g,
    (_, key) => {
      const v = values[key as Placeholder];
      if (v === undefined) return `{${key}}`;
      if (key === 'amount') return v.toLocaleString();
      if (key === 'pct') return String(v);
      return String(v);
    },
  );
  const amount = values.amount;
  const targetAmountCents =
    typeof amount === 'number' && amount > 0 ? Math.round(amount * 100) : 0;
  const targetDate = deriveTargetDate(values);
  return { name: subbed, targetAmountCents, targetDate };
}

function deriveTargetDate(
  values: Partial<Record<Placeholder, number>>,
): string | null {
  const now = new Date();
  if (values.months) {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() + values.months);
    return d.toISOString().slice(0, 10);
  }
  if (values.years) {
    const d = new Date(now);
    d.setUTCFullYear(d.getUTCFullYear() + values.years);
    return d.toISOString().slice(0, 10);
  }
  // {age} is contextual — we can't derive a date without knowing
  // the user's (or child's) current age. Left null; user can edit
  // the date manually on the goal card.
  return null;
}
