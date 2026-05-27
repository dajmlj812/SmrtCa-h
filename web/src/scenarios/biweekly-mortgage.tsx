import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  NumberField,
  monthlyPayment,
  yearsMonthsLabel,
} from './helpers';

interface Inputs {
  balanceCents: number;
  aprPct: number;
  remainingYears: number;
}

const defaults: Inputs = {
  balanceCents: 25000000, // $250,000
  aprPct: 6.5,
  remainingYears: 25,
};

/**
 * Biweekly mortgage payments = pay half the monthly amount every two
 * weeks. 26 biweekly payments per year = 13 monthly payments = one
 * extra full payment per year toward principal. That extra payment
 * compounds into years of saved interest.
 */
function simulate(balanceCents: number, annualPct: number, monthlyPmtCents: number, extraPerYear: number) {
  let bal = balanceCents;
  let monthsPaid = 0;
  let interestPaid = 0;
  const r = annualPct / 100 / 12;
  while (bal > 0 && monthsPaid < 600) {
    const interest = Math.round(bal * r);
    let principal = monthlyPmtCents - interest;
    // Add 1/12 of an extra payment per month (smoothed).
    principal += extraPerYear / 12;
    if (principal <= 0) return null;
    principal = Math.min(principal, bal);
    interestPaid += interest;
    bal -= principal;
    monthsPaid++;
  }
  return { months: monthsPaid, interest: interestPaid };
}

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
      <DollarField
        label="Mortgage balance"
        cents={inputs.balanceCents}
        onChange={(c) => onChange({ ...inputs, balanceCents: c })}
      />
      <NumberField
        label="Interest rate"
        value={inputs.aprPct}
        onChange={(n) => onChange({ ...inputs, aprPct: n })}
        min={0}
        max={15}
        step={0.125}
        suffix="%"
      />
      <NumberField
        label="Years remaining"
        value={inputs.remainingYears}
        onChange={(n) => onChange({ ...inputs, remainingYears: n })}
        min={1}
        max={40}
        suffix="yrs"
      />
    </div>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const months = inputs.remainingYears * 12;
  const monthlyPmt = monthlyPayment(inputs.balanceCents, inputs.aprPct, months);

  const baseline = simulate(inputs.balanceCents, inputs.aprPct, monthlyPmt, 0);
  const biweekly = simulate(inputs.balanceCents, inputs.aprPct, monthlyPmt, monthlyPmt);

  if (!baseline || !biweekly) {
    return (
      <div className="banner error">
        Payment doesn't cover interest at this rate — check the inputs.
      </div>
    );
  }

  const monthsSaved = baseline.months - biweekly.months;
  const interestSaved = baseline.interest - biweekly.interest;

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Standard monthly</h3>
          <CentsMetric label="Payment" cents={monthlyPmt} hint={`× 12 = ${(monthlyPmt * 12 / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}/yr`} />
          <CentsMetric label="Payoff time" cents={0} hint={yearsMonthsLabel(baseline.months)} />
          <CentsMetric label="Total interest" cents={baseline.interest} tone="neg" />
        </div>
        <div className="card" style={{ background: 'var(--accent-soft)' }}>
          <h3 style={{ marginTop: 0 }}>Biweekly</h3>
          <CentsMetric
            label="Per biweekly payment"
            cents={Math.round(monthlyPmt / 2)}
            hint={`26 payments/yr = ${(monthlyPmt * 13 / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} (one extra month)`}
          />
          <CentsMetric label="Payoff time" cents={0} hint={yearsMonthsLabel(biweekly.months)} />
          <CentsMetric label="Total interest" cents={biweekly.interest} />
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Net impact</h3>
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <CentsMetric label="Time saved" cents={0} tone="pos" hint={yearsMonthsLabel(monthsSaved)} />
          <CentsMetric label="Interest saved" cents={interestSaved} tone="pos" />
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          The savings come from making the equivalent of one extra full payment
          per year (26 half-payments = 13 monthly payments). Some servicers
          charge a fee for biweekly auto-pay; setting up two manual half-payments
          per month achieves the same result for free.
        </p>
      </div>
    </>
  );
}

const biweeklyMortgage: ScenarioDef<Inputs> = {
  id: 'biweekly-mortgage',
  title: 'Biweekly mortgage payments',
  subtitle: 'Years shaved and interest saved by paying every two weeks.',
  category: 'debt',
  icon: '🏠',
  defaults,
  Form,
  Result,
};

export default biweeklyMortgage;
