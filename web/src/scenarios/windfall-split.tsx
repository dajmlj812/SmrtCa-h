import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  NumberField,
  futureValueMonthly,
} from './helpers';

interface Inputs {
  amountCents: number;
  emergencyPct: number;
  debtPct: number;
  investPct: number;
  debtApr: number;
  investAnnualReturnPct: number;
  years: number;
}

const defaults: Inputs = {
  amountCents: 500000, // $5,000 windfall
  emergencyPct: 25,
  debtPct: 50,
  investPct: 25,
  debtApr: 22,
  investAnnualReturnPct: 7,
  years: 10,
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  const total = inputs.emergencyPct + inputs.debtPct + inputs.investPct;
  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <DollarField
          label="Windfall amount"
          cents={inputs.amountCents}
          onChange={(c) => onChange({ ...inputs, amountCents: c })}
          hint="Bonus, refund, inheritance, settlement, etc."
        />
        <NumberField
          label="Projection horizon"
          value={inputs.years}
          onChange={(n) => onChange({ ...inputs, years: n })}
          min={1}
          max={40}
          suffix="yrs"
        />
      </div>
      <h3 style={{ marginTop: 12 }}>Split (must total 100%)</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <NumberField
          label="Emergency fund"
          value={inputs.emergencyPct}
          onChange={(n) => onChange({ ...inputs, emergencyPct: n })}
          min={0}
          max={100}
          suffix="%"
        />
        <NumberField
          label="Pay down debt"
          value={inputs.debtPct}
          onChange={(n) => onChange({ ...inputs, debtPct: n })}
          min={0}
          max={100}
          suffix="%"
        />
        <NumberField
          label="Invest"
          value={inputs.investPct}
          onChange={(n) => onChange({ ...inputs, investPct: n })}
          min={0}
          max={100}
          suffix="%"
        />
      </div>
      {total !== 100 && (
        <div className="banner warning" style={{ marginTop: 8 }}>
          Split totals <strong>{total}%</strong> — should equal 100%.
        </div>
      )}
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginTop: 12 }}>
        <NumberField
          label="Debt APR"
          value={inputs.debtApr}
          onChange={(n) => onChange({ ...inputs, debtApr: n })}
          min={0}
          max={40}
          step={0.5}
          suffix="%"
          hint="Avg credit-card rate; lower for personal/student loans."
        />
        <NumberField
          label="Investment return"
          value={inputs.investAnnualReturnPct}
          onChange={(n) => onChange({ ...inputs, investAnnualReturnPct: n })}
          min={0}
          max={20}
          step={0.5}
          suffix="%"
        />
      </div>
    </>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const emergencyCents = (inputs.amountCents * inputs.emergencyPct) / 100;
  const debtCents = (inputs.amountCents * inputs.debtPct) / 100;
  const investCents = (inputs.amountCents * inputs.investPct) / 100;
  const months = inputs.years * 12;

  // Emergency: held in HYSA at ~4% (rough).
  const emergencyEnding = futureValueMonthly(emergencyCents, 0, 4, months);
  // Debt: dollars wiped at debtApr — equivalent to a guaranteed return of debtApr.
  const debtAvoidedInterest =
    futureValueMonthly(debtCents, 0, inputs.debtApr, months) - debtCents;
  // Invest: at investAnnualReturnPct.
  const investEnding = futureValueMonthly(
    investCents,
    0,
    inputs.investAnnualReturnPct,
    months,
  );

  const totalImpact = emergencyEnding + debtAvoidedInterest + investEnding;

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <CentsMetric
          label="Emergency fund"
          cents={emergencyCents}
          hint={`Grows to ${(emergencyEnding / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} in HYSA`}
        />
        <CentsMetric
          label="Toward debt"
          cents={debtCents}
          tone="pos"
          hint={`Avoids ~${(debtAvoidedInterest / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} in interest at ${inputs.debtApr}% APR`}
        />
        <CentsMetric
          label="Invested"
          cents={investCents}
          hint={`Grows to ${(investEnding / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} at ${inputs.investAnnualReturnPct}%`}
        />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Cumulative impact over {inputs.years} years</h3>
        <CentsMetric label="Combined value (savings + interest avoided + portfolio)" cents={totalImpact} tone="pos" />
        <p className="muted small" style={{ marginTop: 8 }}>
          Paying high-APR debt usually wins on guaranteed-return alone:
          {inputs.debtApr > inputs.investAnnualReturnPct
            ? ` your debt at ${inputs.debtApr}% beats the ${inputs.investAnnualReturnPct}% investment return — every dollar to debt is worth more.`
            : ` your investment return (${inputs.investAnnualReturnPct}%) edges the debt rate (${inputs.debtApr}%) — investing wins on expected value, but debt payoff is risk-free.`}
        </p>
      </div>
    </>
  );
}

const windfallSplit: ScenarioDef<Inputs> = {
  id: 'windfall-split',
  title: 'Windfall split',
  subtitle: 'Bonus / refund / inheritance: model splitting between debt, savings, invest.',
  category: 'wealth',
  icon: '🎁',
  defaults,
  Form,
  Result,
};

export default windfallSplit;
