/**
 * 0.18.6 — debt-payoff plan calculator (snowball + avalanche).
 *
 * Standard textbook math:
 *   - "Snowball" pays off accounts ordered by SMALLEST BALANCE
 *     first. Psychologically motivating ("kill one quickly").
 *   - "Avalanche" pays off accounts ordered by HIGHEST APR first.
 *     Mathematically optimal (minimum total interest paid).
 *
 * Both strategies make minimum payments on every debt, then funnel
 * any "extra" (operator-supplied + freed-up minimums from paid-off
 * debts) into the current focus account.
 *
 * We cap iteration at 600 months (50 years). If a plan doesn't pay
 * off within the cap, the result includes `unpayable: true` — that
 * is feedback worth surfacing ("your minimums don't cover the
 * interest").
 */

export interface PayoffAccountInput {
  id: string;
  name: string;
  balanceCents: number; // positive number (we treat debt as a magnitude)
  aprPercent: number; // e.g. 24.99
  minPaymentCents: number;
}

export interface PayoffMonth {
  month: number; // 0 = "now"
  totalBalanceCents: number;
  totalInterestThisMonth: number;
  totalPaidThisMonth: number;
  perAccount: Array<{
    accountId: string;
    balanceCents: number;
    interestCents: number;
    paymentCents: number;
  }>;
}

export interface PayoffPlan {
  strategy: 'snowball' | 'avalanche';
  monthsToPayoff: number;
  totalInterestCents: number;
  totalPaidCents: number;
  perAccount: Array<{
    accountId: string;
    name: string;
    monthsToPayoff: number;
    interestPaidCents: number;
    totalPaidCents: number;
  }>;
  /** Sampled monthly snapshots — full history for charting. */
  schedule: PayoffMonth[];
  /** True when the calculator hit the 600-month cap without finishing. */
  unpayable: boolean;
  /** Diagnostic: any account whose minimum payment is below its
   *  monthly interest (so the balance grows). */
  minTooLowAccountIds: string[];
}

const MAX_MONTHS = 600;

function orderForStrategy(
  inputs: PayoffAccountInput[],
  strategy: 'snowball' | 'avalanche',
): PayoffAccountInput[] {
  const sorted = [...inputs];
  if (strategy === 'snowball') {
    sorted.sort((a, b) => a.balanceCents - b.balanceCents);
  } else {
    sorted.sort((a, b) => b.aprPercent - a.aprPercent);
  }
  return sorted;
}

/**
 * Walk N months. `extraCents` is added to the focus account's
 * minimum payment each month; as accounts pay off their min
 * payments roll into the focus.
 */
export function computePayoffPlan(
  inputs: PayoffAccountInput[],
  strategy: 'snowball' | 'avalanche',
  extraCents: number,
): PayoffPlan {
  const ordered = orderForStrategy(inputs, strategy);
  const state = ordered.map((a) => ({
    ...a,
    paid: 0,
    interest: 0,
    monthsToPayoff: 0,
  }));
  const schedule: PayoffMonth[] = [];
  const minTooLow = new Set<string>();

  let month = 0;
  let unpayable = false;
  for (; month < MAX_MONTHS; month++) {
    // Snapshot current balances.
    const perAccount: PayoffMonth['perAccount'] = [];
    let totalBalance = 0;
    let totalInterest = 0;
    let totalPaid = 0;
    // Capture per-month numbers below as we mutate state.

    // Find focus = first not-paid-off in the ordered list.
    const focusIdx = state.findIndex((a) => a.balanceCents > 0);
    if (focusIdx === -1) break; // all debts paid

    // 1) Apply interest, accrued at APR / 12 per month.
    for (const a of state) {
      if (a.balanceCents <= 0) {
        perAccount.push({
          accountId: a.id,
          balanceCents: 0,
          interestCents: 0,
          paymentCents: 0,
        });
        continue;
      }
      const monthlyRate = a.aprPercent / 100 / 12;
      const interest = Math.round(a.balanceCents * monthlyRate);
      a.balanceCents += interest;
      a.interest += interest;
      totalInterest += interest;
      // Flag accounts whose min payment can't even cover interest —
      // they'll never pay down. Once flagged, stay flagged.
      if (a.minPaymentCents <= interest) minTooLow.add(a.id);

      perAccount.push({
        accountId: a.id,
        balanceCents: a.balanceCents,
        interestCents: interest,
        paymentCents: 0,
      });
    }

    // 2) Compute the payment pool. Every active account chips in
    //    its minimum; the focus account gets the extra + any
    //    freed-up minimums from already-paid-off accounts.
    let freedUp = 0;
    for (const a of state) {
      if (a.balanceCents <= 0) freedUp += a.minPaymentCents;
    }

    // 3) Apply payments in order.
    for (let i = 0; i < state.length; i++) {
      const a = state[i]!;
      if (a.balanceCents <= 0) continue;
      let pay = Math.min(a.minPaymentCents, a.balanceCents);
      if (i === focusIdx) {
        pay = Math.min(a.balanceCents, a.minPaymentCents + extraCents + freedUp);
      }
      a.balanceCents -= pay;
      a.paid += pay;
      totalPaid += pay;
      if (a.balanceCents <= 0 && a.monthsToPayoff === 0) {
        a.monthsToPayoff = month + 1;
      }
      // record into the per-account snapshot we already pushed
      perAccount[state.indexOf(a)]!.paymentCents = pay;
      perAccount[state.indexOf(a)]!.balanceCents = a.balanceCents;
    }

    totalBalance = state.reduce((s, a) => s + Math.max(0, a.balanceCents), 0);
    schedule.push({
      month: month + 1,
      totalBalanceCents: totalBalance,
      totalInterestThisMonth: totalInterest,
      totalPaidThisMonth: totalPaid,
      perAccount,
    });

    if (totalBalance <= 0) {
      month = month + 1;
      break;
    }
  }
  if (month >= MAX_MONTHS) unpayable = true;

  return {
    strategy,
    monthsToPayoff: unpayable ? MAX_MONTHS : month,
    totalInterestCents: state.reduce((s, a) => s + a.interest, 0),
    totalPaidCents: state.reduce((s, a) => s + a.paid, 0),
    perAccount: state.map((a) => ({
      accountId: a.id,
      name: a.name,
      monthsToPayoff: a.monthsToPayoff || (unpayable ? MAX_MONTHS : 0),
      interestPaidCents: a.interest,
      totalPaidCents: a.paid,
    })),
    schedule,
    unpayable,
    minTooLowAccountIds: Array.from(minTooLow),
  };
}
