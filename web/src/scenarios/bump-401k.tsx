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
  annualSalaryCents: number;
  currentContribPct: number;
  newContribPct: number;
  employerMatchPct: number;
  employerMatchCapPct: number;
  marginalTaxPct: number;
  yearsToRetirement: number;
  annualReturnPct: number;
  currentBalanceCents: number;
}

const defaults: Inputs = {
  annualSalaryCents: 7500000, // $75k
  currentContribPct: 5,
  newContribPct: 10,
  employerMatchPct: 50,
  employerMatchCapPct: 6,
  marginalTaxPct: 22,
  yearsToRetirement: 25,
  annualReturnPct: 7,
  currentBalanceCents: 0,
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
      <DollarField
        label="Annual salary"
        cents={inputs.annualSalaryCents}
        onChange={(c) => onChange({ ...inputs, annualSalaryCents: c })}
      />
      <DollarField
        label="Current 401(k) balance"
        cents={inputs.currentBalanceCents}
        onChange={(c) => onChange({ ...inputs, currentBalanceCents: c })}
      />
      <NumberField
        label="Current contribution"
        value={inputs.currentContribPct}
        onChange={(n) => onChange({ ...inputs, currentContribPct: n })}
        min={0}
        max={50}
        suffix="% of salary"
      />
      <NumberField
        label="New contribution"
        value={inputs.newContribPct}
        onChange={(n) => onChange({ ...inputs, newContribPct: n })}
        min={0}
        max={50}
        suffix="% of salary"
      />
      <NumberField
        label="Employer match"
        value={inputs.employerMatchPct}
        onChange={(n) => onChange({ ...inputs, employerMatchPct: n })}
        min={0}
        max={100}
        suffix="% of contribution"
        hint="50% match means employer adds 50¢ per $1 you contribute."
      />
      <NumberField
        label="Match cap"
        value={inputs.employerMatchCapPct}
        onChange={(n) => onChange({ ...inputs, employerMatchCapPct: n })}
        min={0}
        max={20}
        suffix="% of salary"
        hint="Most employers stop matching at 4–6% of salary."
      />
      <NumberField
        label="Marginal tax rate"
        value={inputs.marginalTaxPct}
        onChange={(n) => onChange({ ...inputs, marginalTaxPct: n })}
        min={0}
        max={50}
        suffix="%"
      />
      <NumberField
        label="Years to retirement"
        value={inputs.yearsToRetirement}
        onChange={(n) => onChange({ ...inputs, yearsToRetirement: n })}
        min={1}
        max={50}
        suffix="yrs"
      />
      <NumberField
        label="Annual return"
        value={inputs.annualReturnPct}
        onChange={(n) => onChange({ ...inputs, annualReturnPct: n })}
        min={0}
        max={20}
        step={0.5}
        suffix="%"
      />
    </div>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const employeeCurrent =
    (inputs.annualSalaryCents * inputs.currentContribPct) / 100;
  const employeeNew =
    (inputs.annualSalaryCents * inputs.newContribPct) / 100;

  const employerCap =
    (inputs.annualSalaryCents * inputs.employerMatchCapPct) / 100;
  const employerOnContrib = (contrib: number) =>
    Math.min(contrib, employerCap) * (inputs.employerMatchPct / 100);

  const totalCurrent = employeeCurrent + employerOnContrib(employeeCurrent);
  const totalNew = employeeNew + employerOnContrib(employeeNew);

  // Take-home delta: contributing more cuts take-home by (1 − tax rate)
  // times the extra pre-tax contribution. The tax savings reduces the bite.
  const extraContribAnnual = employeeNew - employeeCurrent;
  const takeHomeAnnualDelta = extraContribAnnual * (1 - inputs.marginalTaxPct / 100);
  const takeHomeMonthlyDelta = takeHomeAnnualDelta / 12;
  const taxSavingsAnnual = extraContribAnnual * (inputs.marginalTaxPct / 100);

  // Projected ending balance at retirement.
  const months = inputs.yearsToRetirement * 12;
  const endingCurrent = futureValueMonthly(
    inputs.currentBalanceCents,
    totalCurrent / 12,
    inputs.annualReturnPct,
    months,
  );
  const endingNew = futureValueMonthly(
    inputs.currentBalanceCents,
    totalNew / 12,
    inputs.annualReturnPct,
    months,
  );
  const endingDelta = endingNew - endingCurrent;

  const missingMatch = employeeNew < employerCap;

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <CentsMetric
          label="Annual contribution change"
          cents={extraContribAnnual}
          tone="pos"
          hint={`+${formatCents(extraContribAnnual / 12)}/mo pre-tax`}
        />
        <CentsMetric
          label="Take-home hit (after tax savings)"
          cents={-Math.round(takeHomeAnnualDelta)}
          tone="neg"
          hint={`~${formatCents(-Math.round(takeHomeMonthlyDelta))}/mo`}
        />
        <CentsMetric
          label="Tax savings this year"
          cents={Math.round(taxSavingsAnnual)}
          tone="pos"
        />
      </div>
      <div
        className="card-grid"
        style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}
      >
        <CentsMetric label="Balance at retirement (current)" cents={endingCurrent} />
        <CentsMetric
          label="Balance at retirement (new)"
          cents={endingNew}
          tone="pos"
        />
        <CentsMetric
          label="Difference"
          cents={endingDelta}
          tone="pos"
          hint={`Over ${inputs.yearsToRetirement} years of compounding`}
        />
      </div>
      {missingMatch && (
        <div className="banner warning" style={{ marginTop: 12 }}>
          <strong>Leaving free money on the table.</strong> At {inputs.newContribPct}% you're below
          your employer's match cap of {inputs.employerMatchCapPct}%. Bumping to at least
          the cap captures the full match.
        </div>
      )}
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Per paycheck math</h3>
        <Metric
          label="Extra you'll see come OUT of your paycheck (monthly)"
          value={formatCents(Math.round(takeHomeMonthlyDelta))}
          hint="Less than the contribution change because your pre-tax dollars reduce taxable income."
        />
      </div>
    </>
  );
}

const bump401k: ScenarioDef<Inputs> = {
  id: 'bump-401k',
  title: 'Bump 401(k) to N%',
  subtitle: 'Take-home impact today vs retirement balance impact later.',
  category: 'wealth',
  icon: '💰',
  defaults,
  Form,
  Result,
};

export default bump401k;
