import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  NumberField,
  yearsMonthsLabel,
} from './helpers';

interface Inputs {
  monthlySpendCents: number;
  monthlyHealthcareDuringCents: number;
  sabbaticalMonths: number;
  startingEmergencyCents: number;
  expectedSeverancePayCents: number;
  newMonthlyTakeHomeOnReturnCents: number;
  monthlySavingsOnReturnCents: number;
}

const defaults: Inputs = {
  monthlySpendCents: 500000, // $5,000/mo living
  monthlyHealthcareDuringCents: 80000, // $800/mo COBRA / marketplace
  sabbaticalMonths: 6,
  startingEmergencyCents: 3000000, // $30,000
  expectedSeverancePayCents: 0,
  newMonthlyTakeHomeOnReturnCents: 600000, // $6,000/mo
  monthlySavingsOnReturnCents: 100000, // $1,000/mo to rebuild
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>During the break</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <DollarField
          label="Monthly living expenses"
          cents={inputs.monthlySpendCents}
          onChange={(c) => onChange({ ...inputs, monthlySpendCents: c })}
          hint="Rent/mortgage + everything you still spend on while not working."
        />
        <DollarField
          label="Monthly healthcare"
          cents={inputs.monthlyHealthcareDuringCents}
          onChange={(c) => onChange({ ...inputs, monthlyHealthcareDuringCents: c })}
          hint="COBRA or marketplace premium without employer subsidy."
        />
        <NumberField
          label="Length of break"
          value={inputs.sabbaticalMonths}
          onChange={(n) => onChange({ ...inputs, sabbaticalMonths: n })}
          min={1}
          max={36}
          suffix="months"
        />
        <DollarField
          label="Severance / final pay"
          cents={inputs.expectedSeverancePayCents}
          onChange={(c) => onChange({ ...inputs, expectedSeverancePayCents: c })}
        />
      </div>
      <h3 style={{ marginTop: 12 }}>Starting cushion</h3>
      <DollarField
        label="Emergency fund + savings available"
        cents={inputs.startingEmergencyCents}
        onChange={(c) => onChange({ ...inputs, startingEmergencyCents: c })}
      />
      <h3 style={{ marginTop: 12 }}>After return</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <DollarField
          label="Monthly take-home back at work"
          cents={inputs.newMonthlyTakeHomeOnReturnCents}
          onChange={(c) => onChange({ ...inputs, newMonthlyTakeHomeOnReturnCents: c })}
        />
        <DollarField
          label="Monthly savings to rebuild"
          cents={inputs.monthlySavingsOnReturnCents}
          onChange={(c) => onChange({ ...inputs, monthlySavingsOnReturnCents: c })}
        />
      </div>
    </>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const monthlyBurn = inputs.monthlySpendCents + inputs.monthlyHealthcareDuringCents;
  const totalCash = inputs.startingEmergencyCents + inputs.expectedSeverancePayCents;
  const runway = monthlyBurn > 0 ? totalCash / monthlyBurn : Infinity;
  const totalCostOfBreak = monthlyBurn * inputs.sabbaticalMonths;
  const cashAtReturn = totalCash - totalCostOfBreak;
  const shortfall = Math.max(0, -cashAtReturn);

  // Rebuild time: how many months to return to starting emergency fund level
  // after restarting work at monthlySavingsOnReturnCents.
  const rebuildMonths =
    inputs.monthlySavingsOnReturnCents > 0
      ? Math.ceil(
          (inputs.startingEmergencyCents - Math.max(0, cashAtReturn)) /
            inputs.monthlySavingsOnReturnCents,
        )
      : null;

  const safe = cashAtReturn >= 0;

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <CentsMetric label="Monthly burn during break" cents={monthlyBurn} tone="neg" />
        <CentsMetric
          label="Runway at burn rate"
          cents={0}
          hint={Number.isFinite(runway) ? `${runway.toFixed(1)} months` : '∞'}
          tone={runway < inputs.sabbaticalMonths ? 'neg' : 'pos'}
        />
        <CentsMetric
          label="Total cost of break"
          cents={totalCostOfBreak}
          tone="neg"
        />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Cash at end of break</h3>
        <CentsMetric
          label={safe ? 'Remaining cushion when you go back to work' : 'Shortfall — you run out before the break ends'}
          cents={safe ? cashAtReturn : -shortfall}
          tone={safe ? 'pos' : 'neg'}
        />
        {!safe && (
          <div className="banner error" style={{ marginTop: 12 }}>
            At {(monthlyBurn / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}/mo,
            you run out of cash after roughly {runway.toFixed(1)} months —
            that's {inputs.sabbaticalMonths - Math.floor(runway)} months short
            of your target break length. Trim the break, cut spend, or save more before starting.
          </div>
        )}
      </div>
      {safe && rebuildMonths !== null && rebuildMonths > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Rebuild path</h3>
          <CentsMetric
            label="Time to restore starting cushion"
            cents={0}
            hint={yearsMonthsLabel(rebuildMonths)}
          />
          <p className="muted small" style={{ marginTop: 8 }}>
            At {(inputs.monthlySavingsOnReturnCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}/mo saved after returning.
          </p>
        </div>
      )}
    </>
  );
}

const sabbatical: ScenarioDef<Inputs> = {
  id: 'sabbatical',
  title: 'Sabbatical / income loss',
  subtitle: 'How long does the cushion last and how long to rebuild after?',
  category: 'life-event',
  icon: '🏖️',
  defaults,
  Form,
  Result,
};

export default sabbatical;
