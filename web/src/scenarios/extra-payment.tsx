import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  NumberField,
  monthsToPayoff,
  totalInterest,
  yearsMonthsLabel,
} from './helpers';

interface Inputs {
  balanceCents: number;
  aprPct: number;
  minPaymentCents: number;
  extraCents: number;
}

const defaults: Inputs = {
  balanceCents: 800000, // $8,000
  aprPct: 22,
  minPaymentCents: 20000, // $200/mo
  extraCents: 10000, // $100/mo extra
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
      <DollarField
        label="Current balance"
        cents={inputs.balanceCents}
        onChange={(c) => onChange({ ...inputs, balanceCents: c })}
      />
      <NumberField
        label="APR"
        value={inputs.aprPct}
        onChange={(n) => onChange({ ...inputs, aprPct: n })}
        min={0}
        max={40}
        step={0.5}
        suffix="%"
      />
      <DollarField
        label="Current minimum payment"
        cents={inputs.minPaymentCents}
        onChange={(c) => onChange({ ...inputs, minPaymentCents: c })}
      />
      <DollarField
        label="Extra per month"
        cents={inputs.extraCents}
        onChange={(c) => onChange({ ...inputs, extraCents: c })}
      />
    </div>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const baseMonths = monthsToPayoff(inputs.balanceCents, inputs.aprPct, inputs.minPaymentCents);
  const newPayment = inputs.minPaymentCents + inputs.extraCents;
  const newMonths = monthsToPayoff(inputs.balanceCents, inputs.aprPct, newPayment);

  const baseInterest =
    baseMonths === null
      ? null
      : totalInterest(inputs.balanceCents, inputs.aprPct, inputs.minPaymentCents, baseMonths);
  const newInterest =
    newMonths === null
      ? null
      : totalInterest(inputs.balanceCents, inputs.aprPct, newPayment, newMonths);

  const monthsSaved =
    baseMonths !== null && newMonths !== null ? baseMonths - newMonths : null;
  const interestSaved =
    baseInterest !== null && newInterest !== null
      ? baseInterest - newInterest
      : null;

  return (
    <>
      {(baseMonths === null || newMonths === null) && (
        <div className="banner error">
          Payment is less than the monthly interest — the balance won't go down.
          Increase the payment until it exceeds {' '}
          {((inputs.balanceCents * inputs.aprPct) / 1200 / 100).toFixed(2)} /mo.
        </div>
      )}
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Current trajectory</h3>
          <p className="muted small">
            Paying {(inputs.minPaymentCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}/mo
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <CentsMetric
              label="Payoff time"
              cents={0}
              hint={baseMonths === null ? '—' : yearsMonthsLabel(baseMonths)}
            />
            <CentsMetric label="Total interest" cents={baseInterest ?? 0} tone="neg" />
          </div>
        </div>
        <div className="card" style={{ background: 'var(--accent-soft)' }}>
          <h3 style={{ marginTop: 0 }}>With extra $/mo</h3>
          <p className="muted small">
            Paying {(newPayment / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}/mo
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <CentsMetric
              label="Payoff time"
              cents={0}
              hint={newMonths === null ? '—' : yearsMonthsLabel(newMonths)}
            />
            <CentsMetric label="Total interest" cents={newInterest ?? 0} tone="pos" />
          </div>
        </div>
      </div>
      {monthsSaved !== null && interestSaved !== null && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Net impact</h3>
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <CentsMetric
              label="Time saved"
              cents={0}
              tone="pos"
              hint={yearsMonthsLabel(monthsSaved)}
            />
            <CentsMetric label="Interest saved" cents={interestSaved} tone="pos" />
          </div>
        </div>
      )}
    </>
  );
}

const extraPayment: ScenarioDef<Inputs> = {
  id: 'extra-payment',
  title: 'Add $X/mo extra payment',
  subtitle: 'How much time and interest does an extra payment buy?',
  category: 'debt',
  icon: '💪',
  defaults,
  Form,
  Result,
};

export default extraPayment;
