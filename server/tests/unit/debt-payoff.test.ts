import { describe, it, expect } from 'vitest';
import { computePayoffPlan } from '../../src/domain/debt-payoff.js';

describe('computePayoffPlan (0.18.6)', () => {
  it('pays off a single zero-interest debt in balance/min months', () => {
    const r = computePayoffPlan(
      [
        {
          id: 'a',
          name: 'A',
          balanceCents: 100_00,
          aprPercent: 0,
          minPaymentCents: 10_00,
        },
      ],
      'avalanche',
      0,
    );
    expect(r.unpayable).toBe(false);
    expect(r.monthsToPayoff).toBe(10);
    expect(r.totalInterestCents).toBe(0);
    expect(r.totalPaidCents).toBe(100_00);
  });

  it('avalanche orders by APR; snowball orders by balance', () => {
    const accounts = [
      { id: 'small', name: 'small', balanceCents: 500_00, aprPercent: 5, minPaymentCents: 25_00 },
      { id: 'big', name: 'big', balanceCents: 5_000_00, aprPercent: 25, minPaymentCents: 100_00 },
    ];
    const snow = computePayoffPlan(accounts, 'snowball', 100_00);
    const aval = computePayoffPlan(accounts, 'avalanche', 100_00);
    const snowSmall = snow.perAccount.find((p) => p.accountId === 'small')!;
    const snowBig = snow.perAccount.find((p) => p.accountId === 'big')!;
    const avalSmall = aval.perAccount.find((p) => p.accountId === 'small')!;
    const avalBig = aval.perAccount.find((p) => p.accountId === 'big')!;
    // Snowball focuses the extra on the SMALLER balance, so under
    // snowball the small debt finishes faster than under avalanche.
    expect(snowSmall.monthsToPayoff).toBeLessThan(avalSmall.monthsToPayoff);
    // Avalanche focuses the extra on the HIGHER APR, so under
    // avalanche the big (higher-APR) debt finishes faster than
    // under snowball.
    expect(avalBig.monthsToPayoff).toBeLessThan(snowBig.monthsToPayoff);
  });

  it('flags accounts whose min payment cannot cover the interest', () => {
    const r = computePayoffPlan(
      [
        // $10k at 24% APR = $200/month interest. $50 min won't pay it down.
        {
          id: 'underwater',
          name: 'cc',
          balanceCents: 10_000_00,
          aprPercent: 24,
          minPaymentCents: 50_00,
        },
      ],
      'avalanche',
      0,
    );
    expect(r.minTooLowAccountIds).toContain('underwater');
    expect(r.unpayable).toBe(true);
  });

  it('rolls freed-up minimums into the focus account once others pay off', () => {
    // After the small one finishes, its $50/min should accelerate
    // the big one.
    const fast = computePayoffPlan(
      [
        { id: 'a', name: 'small', balanceCents: 100_00, aprPercent: 0, minPaymentCents: 50_00 },
        { id: 'b', name: 'big', balanceCents: 10_000_00, aprPercent: 0, minPaymentCents: 100_00 },
      ],
      'snowball',
      0,
    );
    // Without the snowball roll-up, big alone would take 100 months
    // ($100/mo). With the snowball mechanic, after small finishes
    // in 2 months, big gets $150/mo and finishes faster.
    const big = fast.perAccount.find((p) => p.accountId === 'b')!;
    expect(big.monthsToPayoff).toBeLessThan(100);
  });
});
