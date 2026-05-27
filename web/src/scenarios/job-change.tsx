import { formatCents } from '../format';
import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  Metric,
  NumberField,
  futureValueMonthly,
} from './helpers';

interface Inputs {
  currentSalaryCents: number;
  currentMatchPct: number;
  currentMatchCapPct: number;
  currentBenefitsValueAnnualCents: number;

  newSalaryCents: number;
  newMatchPct: number;
  newMatchCapPct: number;
  newBenefitsValueAnnualCents: number;

  relocationCostCents: number;
  costOfLivingDeltaPct: number; // +20 = 20% more expensive
  yearsHorizon: number;
  contribPct: number; // 401k contribution % at both jobs
  annualReturnPct: number;
}

const defaults: Inputs = {
  currentSalaryCents: 9000000, // $90k
  currentMatchPct: 50,
  currentMatchCapPct: 6,
  currentBenefitsValueAnnualCents: 600000, // $6k

  newSalaryCents: 11000000, // $110k
  newMatchPct: 100,
  newMatchCapPct: 4,
  newBenefitsValueAnnualCents: 800000, // $8k

  relocationCostCents: 500000, // $5k
  costOfLivingDeltaPct: 10,
  yearsHorizon: 5,
  contribPct: 10,
  annualReturnPct: 7,
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Current job</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <DollarField
          label="Salary"
          cents={inputs.currentSalaryCents}
          onChange={(c) => onChange({ ...inputs, currentSalaryCents: c })}
        />
        <DollarField
          label="Benefits value (annual)"
          cents={inputs.currentBenefitsValueAnnualCents}
          onChange={(c) => onChange({ ...inputs, currentBenefitsValueAnnualCents: c })}
          hint="Premium subsidy, equity, PTO, bonus, etc."
        />
        <NumberField
          label="Employer match"
          value={inputs.currentMatchPct}
          onChange={(n) => onChange({ ...inputs, currentMatchPct: n })}
          min={0}
          max={100}
          suffix="% of contribution"
        />
        <NumberField
          label="Match cap"
          value={inputs.currentMatchCapPct}
          onChange={(n) => onChange({ ...inputs, currentMatchCapPct: n })}
          min={0}
          max={20}
          suffix="% of salary"
        />
      </div>
      <h3 style={{ marginTop: 12 }}>New job</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <DollarField
          label="Salary"
          cents={inputs.newSalaryCents}
          onChange={(c) => onChange({ ...inputs, newSalaryCents: c })}
        />
        <DollarField
          label="Benefits value (annual)"
          cents={inputs.newBenefitsValueAnnualCents}
          onChange={(c) => onChange({ ...inputs, newBenefitsValueAnnualCents: c })}
        />
        <NumberField
          label="Employer match"
          value={inputs.newMatchPct}
          onChange={(n) => onChange({ ...inputs, newMatchPct: n })}
          min={0}
          max={100}
          suffix="% of contribution"
        />
        <NumberField
          label="Match cap"
          value={inputs.newMatchCapPct}
          onChange={(n) => onChange({ ...inputs, newMatchCapPct: n })}
          min={0}
          max={20}
          suffix="% of salary"
        />
      </div>
      <h3 style={{ marginTop: 12 }}>Other deltas</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <DollarField
          label="Relocation cost (one-time)"
          cents={inputs.relocationCostCents}
          onChange={(c) => onChange({ ...inputs, relocationCostCents: c })}
        />
        <NumberField
          label="Cost-of-living delta"
          value={inputs.costOfLivingDeltaPct}
          onChange={(n) => onChange({ ...inputs, costOfLivingDeltaPct: n })}
          min={-50}
          max={100}
          suffix="%"
          hint="+15 = new city is 15% more expensive."
        />
        <NumberField
          label="Years to project"
          value={inputs.yearsHorizon}
          onChange={(n) => onChange({ ...inputs, yearsHorizon: n })}
          min={1}
          max={20}
          suffix="yrs"
        />
        <NumberField
          label="Your 401(k) contribution"
          value={inputs.contribPct}
          onChange={(n) => onChange({ ...inputs, contribPct: n })}
          min={0}
          max={50}
          suffix="% of salary"
        />
      </div>
    </>
  );
}

function totalCompFor(
  salary: number,
  benefits: number,
  contribPct: number,
  matchPct: number,
  matchCapPct: number,
): number {
  const employeeContrib = (salary * contribPct) / 100;
  const employerCap = (salary * matchCapPct) / 100;
  const match = Math.min(employeeContrib, employerCap) * (matchPct / 100);
  return salary + benefits + match;
}

function Result({ inputs }: { inputs: Inputs }) {
  const currentTotal = totalCompFor(
    inputs.currentSalaryCents,
    inputs.currentBenefitsValueAnnualCents,
    inputs.contribPct,
    inputs.currentMatchPct,
    inputs.currentMatchCapPct,
  );
  const newTotal = totalCompFor(
    inputs.newSalaryCents,
    inputs.newBenefitsValueAnnualCents,
    inputs.contribPct,
    inputs.newMatchPct,
    inputs.newMatchCapPct,
  );

  // Effective comp after cost-of-living adjustment: a 10% COL hike means the
  // new salary's purchasing power is salary/(1+0.10) relative to current.
  const colFactor = 1 + inputs.costOfLivingDeltaPct / 100;
  const newColAdjusted = newTotal / colFactor;
  const annualDelta = newColAdjusted - currentTotal;

  // 5-year (or chosen horizon) delta — saved/invested at annualReturnPct.
  const months = inputs.yearsHorizon * 12;
  const monthlyDelta = annualDelta / 12;
  const fvOfDelta = futureValueMonthly(0, monthlyDelta, inputs.annualReturnPct, months);
  const netHorizonDelta = fvOfDelta - inputs.relocationCostCents;

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <CentsMetric label="Current total comp" cents={currentTotal} />
        <CentsMetric label="New total comp" cents={newTotal} />
        <CentsMetric
          label="New comp (COL-adjusted)"
          cents={newColAdjusted}
          hint={`${inputs.costOfLivingDeltaPct >= 0 ? '+' : ''}${inputs.costOfLivingDeltaPct}% cost-of-living`}
        />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Annual delta</h3>
        <Metric
          label="Per year, in current dollars"
          value={formatCents(annualDelta)}
          tone={annualDelta > 0 ? 'pos' : 'neg'}
          hint={annualDelta > 0 ? 'New job pays more in real terms.' : 'New job is a pay cut after COL.'}
        />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>{inputs.yearsHorizon}-year net</h3>
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <CentsMetric
            label="Cumulative comp delta (compounded)"
            cents={fvOfDelta}
            tone={fvOfDelta > 0 ? 'pos' : 'neg'}
          />
          <CentsMetric
            label="Relocation cost"
            cents={inputs.relocationCostCents}
            tone="neg"
          />
          <CentsMetric
            label="Net over {inputs.yearsHorizon} yrs"
            cents={netHorizonDelta}
            tone={netHorizonDelta > 0 ? 'pos' : 'neg'}
          />
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          Assumes the comp delta is saved/invested at {inputs.annualReturnPct}% annually.
          Doesn't model tax-bracket differences, equity vesting, or non-financial
          factors (commute, manager, growth).
        </p>
      </div>
    </>
  );
}

const jobChange: ScenarioDef<Inputs> = {
  id: 'job-change',
  title: 'Job change',
  subtitle: 'Salary + benefits + 401(k) match + cost-of-living + relocation, all at once.',
  category: 'life-event',
  icon: '💼',
  defaults,
  Form,
  Result,
};

export default jobChange;
