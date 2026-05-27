/**
 * 0.21.x — curated goal templates.
 *
 * Each template's `text` contains named placeholders like
 * {amount}, {months}, {years}, {age}. The picker always asks
 * for an amount (the savings_goals row requires a positive
 * target) plus any text placeholders + any default keys; the
 * filled-in text becomes the goal name, the amount becomes
 * targetAmountCents, months/years become the targetDate.
 *
 * Curation principle: every template must map to a $-tracked
 * savings goal with a target date. Habit / ratio / score / task
 * templates (e.g. "Increase credit score above 750",
 * "Reduce impulse spending by 50%", "Diversify across 5 asset
 * classes", "Create a monthly budget for one full year") were
 * dropped — they don't fit the savings_goals schema and lead
 * to "what do I put for the amount?" confusion. Templates that
 * confused a monthly contribution with a total target (e.g.
 * "Save $250 monthly in a 529") were rewritten as total
 * targets so the progress bar measures something real.
 */

export type Placeholder = 'amount' | 'months' | 'years' | 'pct' | 'count' | 'age';

export interface GoalTemplate {
  id: number;
  category: string;
  text: string;
  /** Sensible per-placeholder defaults. */
  defaults?: Partial<Record<Placeholder, number>>;
  /** Optional override for the stored name format. */
  nameTemplate?: string;
}

export const GOAL_TEMPLATES: readonly GoalTemplate[] = [
  // ── Emergency / safety net ───────────────────────────────
  { id: 1, category: 'Emergency fund',
    text: 'Save ${amount} for an emergency fund within {months} months',
    defaults: { amount: 5000, months: 12 } },
  { id: 2, category: 'Emergency fund',
    text: 'Build a six-month living-expense fund of ${amount} within {months} months',
    defaults: { amount: 18000, months: 12 } },

  // ── Debt payoff ──────────────────────────────────────────
  { id: 10, category: 'Debt',
    text: 'Pay off ${amount} in credit card debt within {months} months',
    defaults: { amount: 5000, months: 18 } },
  { id: 11, category: 'Debt',
    text: 'Pay off ${amount} in student loans within {years} years',
    defaults: { amount: 25000, years: 7 } },
  { id: 12, category: 'Debt',
    text: 'Pay off ${amount} of non-mortgage debt within {years} years',
    defaults: { amount: 15000, years: 3 } },
  { id: 13, category: 'Debt',
    text: 'Apply ${amount} in extra principal to pay off the mortgage early within {years} years',
    defaults: { amount: 30000, years: 5 } },

  // ── Home ─────────────────────────────────────────────────
  { id: 20, category: 'Home',
    text: 'Save ${amount} for a home down payment within {years} years',
    defaults: { amount: 60000, years: 5 } },
  { id: 21, category: 'Home',
    text: 'Save ${amount} for home renovations within {months} months',
    defaults: { amount: 15000, months: 18 } },

  // ── Vehicle ──────────────────────────────────────────────
  { id: 30, category: 'Vehicle',
    text: 'Save ${amount} for a new car down payment within {months} months',
    defaults: { amount: 5000, months: 12 } },
  { id: 31, category: 'Vehicle',
    text: 'Build a ${amount} fund for future vehicle replacement within {years} years',
    defaults: { amount: 20000, years: 5 } },

  // ── Education ────────────────────────────────────────────
  { id: 40, category: 'Education',
    text: 'Save ${amount} in a 529 college fund within {years} years',
    defaults: { amount: 60000, years: 10 } },
  { id: 41, category: 'Education',
    text: "Save ${amount} for a child's college tuition by age {age}",
    defaults: { amount: 80000, age: 18 } },
  { id: 42, category: 'Education',
    text: 'Save ${amount} for professional development within {months} months',
    defaults: { amount: 5000, months: 12 } },

  // ── Retirement & investing ───────────────────────────────
  { id: 50, category: 'Retirement',
    text: 'Save ${amount} toward retirement by age {age}',
    defaults: { amount: 1000000, age: 65 } },
  { id: 51, category: 'Retirement',
    text: 'Max out IRA contributions: ${amount} total over the next {years} years',
    defaults: { amount: 70000, years: 10 } },
  { id: 52, category: 'Retirement',
    text: 'Build a health savings account (HSA) to ${amount} within {years} years',
    defaults: { amount: 10000, years: 5 } },
  { id: 53, category: 'Investing',
    text: 'Build an investment portfolio worth ${amount} within {years} years',
    defaults: { amount: 250000, years: 10 } },
  { id: 54, category: 'Investing',
    text: 'Build a dividend portfolio worth ${amount} within {years} years',
    defaults: { amount: 200000, years: 10 } },
  { id: 55, category: 'Investing',
    text: 'Save ${amount} toward a first investment property within {years} years',
    defaults: { amount: 50000, years: 5 } },

  // ── Business ─────────────────────────────────────────────
  { id: 60, category: 'Business',
    text: 'Save ${amount} in business startup capital within {years} years',
    defaults: { amount: 25000, years: 3 } },
  { id: 61, category: 'Business',
    text: 'Build a ${amount} side-business growth fund within {months} months',
    defaults: { amount: 10000, months: 18 } },

  // ── Lifestyle / personal ─────────────────────────────────
  { id: 70, category: 'Lifestyle',
    text: 'Save ${amount} for a dream vacation within {months} months',
    defaults: { amount: 5000, months: 18 } },
  { id: 71, category: 'Lifestyle',
    text: 'Save ${amount} for a wedding within {years} years',
    defaults: { amount: 30000, years: 2 } },
  { id: 72, category: 'Lifestyle',
    text: 'Save ${amount} for a sabbatical from work within {years} years',
    defaults: { amount: 30000, years: 5 } },
  { id: 73, category: 'Lifestyle',
    text: 'Save ${amount} for a year of travel and experiences within {years} years',
    defaults: { amount: 50000, years: 3 } },

  // ── Family / legacy ──────────────────────────────────────
  { id: 80, category: 'Family',
    text: 'Build a ${amount} fund for elderly parent care within {years} years',
    defaults: { amount: 50000, years: 5 } },
  { id: 81, category: 'Family',
    text: 'Build a ${amount} fund for generational wealth transfer within {years} years',
    defaults: { amount: 500000, years: 20 } },

  // ── Independence ─────────────────────────────────────────
  { id: 90, category: 'Independence',
    text: 'Save ${amount} toward financial independence by age {age}',
    defaults: { amount: 1500000, age: 50 } },
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
  // {age} alone is contextual — without the user's (or child's)
  // current age we can't derive a date. The goal still creates;
  // user can edit the date on the goal card afterward.
  return null;
}
