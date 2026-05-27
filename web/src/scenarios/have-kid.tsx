import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  NumberField,
  futureValueMonthly,
} from './helpers';

interface Inputs {
  monthlyChildcareCents: number;
  monthlyGearAndFoodCents: number;
  monthlyHealthcareCents: number;
  oneTimeBabyCostCents: number;
  monthly529Cents: number;
  yearsTo18: number;
  annualReturnPct: number;
  childTaxCreditAnnualCents: number;
}

const defaults: Inputs = {
  monthlyChildcareCents: 180000, // $1,800/mo
  monthlyGearAndFoodCents: 30000, // $300/mo
  monthlyHealthcareCents: 15000, // $150/mo
  oneTimeBabyCostCents: 400000, // $4,000
  monthly529Cents: 25000, // $250/mo
  yearsTo18: 18,
  annualReturnPct: 6,
  childTaxCreditAnnualCents: 200000, // $2,000/yr
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>One-time costs</h3>
      <DollarField
        label="Birth + first-year setup (delivery, gear, nursery)"
        cents={inputs.oneTimeBabyCostCents}
        onChange={(c) => onChange({ ...inputs, oneTimeBabyCostCents: c })}
      />
      <h3 style={{ marginTop: 12 }}>Monthly ongoing</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <DollarField
          label="Childcare"
          cents={inputs.monthlyChildcareCents}
          onChange={(c) => onChange({ ...inputs, monthlyChildcareCents: c })}
          hint="Daycare, after-school, etc."
        />
        <DollarField
          label="Food, gear, clothes"
          cents={inputs.monthlyGearAndFoodCents}
          onChange={(c) => onChange({ ...inputs, monthlyGearAndFoodCents: c })}
        />
        <DollarField
          label="Added healthcare"
          cents={inputs.monthlyHealthcareCents}
          onChange={(c) => onChange({ ...inputs, monthlyHealthcareCents: c })}
          hint="Family plan delta + copays."
        />
      </div>
      <h3 style={{ marginTop: 12 }}>Long-term saving</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <DollarField
          label="Monthly 529 contribution"
          cents={inputs.monthly529Cents}
          onChange={(c) => onChange({ ...inputs, monthly529Cents: c })}
        />
        <NumberField
          label="Years until 18"
          value={inputs.yearsTo18}
          onChange={(n) => onChange({ ...inputs, yearsTo18: n })}
          min={0}
          max={18}
          suffix="yrs"
        />
        <NumberField
          label="529 expected return"
          value={inputs.annualReturnPct}
          onChange={(n) => onChange({ ...inputs, annualReturnPct: n })}
          min={0}
          max={15}
          step={0.5}
          suffix="%"
        />
      </div>
      <DollarField
        label="Annual federal Child Tax Credit"
        cents={inputs.childTaxCreditAnnualCents}
        onChange={(c) => onChange({ ...inputs, childTaxCreditAnnualCents: c })}
        hint="Currently $2,000/yr at most income levels (phases out at higher AGI)."
      />
    </>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const monthlyOngoing =
    inputs.monthlyChildcareCents +
    inputs.monthlyGearAndFoodCents +
    inputs.monthlyHealthcareCents +
    inputs.monthly529Cents;
  const annualOngoing = monthlyOngoing * 12;
  const taxCreditOffset = inputs.childTaxCreditAnnualCents;
  const annualNet = annualOngoing - taxCreditOffset;

  const yearOneTotal = inputs.oneTimeBabyCostCents + annualNet;
  const fiveYearTotal = inputs.oneTimeBabyCostCents + annualNet * 5;
  const eighteenYearTotal =
    inputs.oneTimeBabyCostCents + annualNet * 18;

  const ending529 = futureValueMonthly(
    0,
    inputs.monthly529Cents,
    inputs.annualReturnPct,
    inputs.yearsTo18 * 12,
  );

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <CentsMetric label="Monthly cost added" cents={monthlyOngoing} tone="neg" />
        <CentsMetric label="Annual cost (net of tax credit)" cents={annualNet} tone="neg" />
        <CentsMetric label="529 value at 18" cents={ending529} tone="pos" />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Cumulative cost</h3>
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <CentsMetric label="Year 1" cents={yearOneTotal} tone="neg" hint="Includes one-time birth/setup costs." />
          <CentsMetric label="Years 1–5" cents={fiveYearTotal} tone="neg" />
          <CentsMetric label="Years 1–18" cents={eighteenYearTotal} tone="neg" />
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          These are <em>incremental</em> costs vs. your current household. Income
          changes (parental leave, switching to one-income) are modeled separately
          in the "Sabbatical / income loss" scenario.
        </p>
      </div>
    </>
  );
}

const haveKid: ScenarioDef<Inputs> = {
  id: 'have-kid',
  title: 'Have a kid',
  subtitle: 'Childcare + 529 + tax credit impact across the first 18 years.',
  category: 'life-event',
  icon: '👶',
  defaults,
  Form,
  Result,
};

export default haveKid;
