import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  NumberField,
} from './helpers';

interface Inputs {
  monthlyIncomeCents: number;
  monthlyEssentialsCents: number;
  monthlyDiscretionaryCents: number;
  incomeDropPct: number;
  durationMonths: number;
  startingCashCents: number;
  monthlyEssentialsCutPct: number;
  monthlyDiscretionaryCutPct: number;
}

const defaults: Inputs = {
  monthlyIncomeCents: 800000, // $8,000/mo
  monthlyEssentialsCents: 400000, // $4,000 rent / utilities / insurance / food
  monthlyDiscretionaryCents: 200000, // $2,000 dining / fun / travel
  incomeDropPct: 30, // job loss / pay cut
  durationMonths: 12,
  startingCashCents: 1500000, // $15,000 emergency fund
  monthlyEssentialsCutPct: 5,
  monthlyDiscretionaryCutPct: 50,
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Baseline</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <DollarField
          label="Monthly take-home"
          cents={inputs.monthlyIncomeCents}
          onChange={(c) => onChange({ ...inputs, monthlyIncomeCents: c })}
        />
        <DollarField
          label="Monthly essentials"
          cents={inputs.monthlyEssentialsCents}
          onChange={(c) => onChange({ ...inputs, monthlyEssentialsCents: c })}
          hint="Rent/mortgage, utilities, food, insurance — hard to cut."
        />
        <DollarField
          label="Monthly discretionary"
          cents={inputs.monthlyDiscretionaryCents}
          onChange={(c) => onChange({ ...inputs, monthlyDiscretionaryCents: c })}
          hint="Dining out, travel, subscriptions, fun money — easy to cut."
        />
      </div>
      <DollarField
        label="Emergency cash on hand"
        cents={inputs.startingCashCents}
        onChange={(c) => onChange({ ...inputs, startingCashCents: c })}
      />
      <h3 style={{ marginTop: 12 }}>The shock</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <NumberField
          label="Income drop"
          value={inputs.incomeDropPct}
          onChange={(n) => onChange({ ...inputs, incomeDropPct: n })}
          min={0}
          max={100}
          suffix="%"
          hint="100% = full job loss; 30% = pay cut / reduced hours."
        />
        <NumberField
          label="Duration"
          value={inputs.durationMonths}
          onChange={(n) => onChange({ ...inputs, durationMonths: n })}
          min={1}
          max={36}
          suffix="months"
        />
      </div>
      <h3 style={{ marginTop: 12 }}>Belt-tightening response</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <NumberField
          label="Essentials cut"
          value={inputs.monthlyEssentialsCutPct}
          onChange={(n) => onChange({ ...inputs, monthlyEssentialsCutPct: n })}
          min={0}
          max={50}
          suffix="%"
        />
        <NumberField
          label="Discretionary cut"
          value={inputs.monthlyDiscretionaryCutPct}
          onChange={(n) => onChange({ ...inputs, monthlyDiscretionaryCutPct: n })}
          min={0}
          max={100}
          suffix="%"
        />
      </div>
    </>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const baselineNet =
    inputs.monthlyIncomeCents -
    inputs.monthlyEssentialsCents -
    inputs.monthlyDiscretionaryCents;

  const shockedIncome = inputs.monthlyIncomeCents * (1 - inputs.incomeDropPct / 100);
  const shockedEssentials =
    inputs.monthlyEssentialsCents * (1 - inputs.monthlyEssentialsCutPct / 100);
  const shockedDiscretionary =
    inputs.monthlyDiscretionaryCents * (1 - inputs.monthlyDiscretionaryCutPct / 100);
  const shockedNet = shockedIncome - shockedEssentials - shockedDiscretionary;

  const monthlyBurn = shockedNet < 0 ? -shockedNet : 0;
  const totalShortfall = monthlyBurn * inputs.durationMonths;
  const runway = monthlyBurn > 0 ? inputs.startingCashCents / monthlyBurn : Infinity;
  const cashAtEnd =
    shockedNet >= 0
      ? inputs.startingCashCents + shockedNet * inputs.durationMonths
      : inputs.startingCashCents - totalShortfall;

  const survives = cashAtEnd >= 0;
  const breaksAt = monthlyBurn > 0 ? Math.floor(runway) : null;

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <CentsMetric label="Baseline monthly net" cents={baselineNet} tone={baselineNet >= 0 ? 'pos' : 'neg'} />
        <CentsMetric
          label="Shocked monthly net"
          cents={Math.round(shockedNet)}
          tone={shockedNet >= 0 ? 'pos' : 'neg'}
          hint={shockedNet < 0 ? 'Burning savings every month' : 'Still saving, just slower'}
        />
        <CentsMetric
          label="Runway at shocked burn"
          cents={0}
          hint={Number.isFinite(runway) ? `${runway.toFixed(1)} months` : '∞'}
          tone={Number.isFinite(runway) && runway < inputs.durationMonths ? 'neg' : 'pos'}
        />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>End-of-shock cash position</h3>
        <CentsMetric
          label={survives ? 'Remaining cash after shock' : `Shortfall before month ${inputs.durationMonths}`}
          cents={Math.round(cashAtEnd)}
          tone={survives ? 'pos' : 'neg'}
        />
        {!survives && breaksAt !== null && (
          <div className="banner error" style={{ marginTop: 12 }}>
            You run out of cash around month <strong>{breaksAt}</strong> — that's{' '}
            {inputs.durationMonths - breaksAt} months short of the shock duration.
            Consider trimming essentials further (the discretionary cut is already
            {' '}{inputs.monthlyDiscretionaryCutPct}%), drawing on credit, or unemployment income.
          </div>
        )}
        {survives && shockedNet < 0 && (
          <div className="banner warning" style={{ marginTop: 12 }}>
            You make it, but the cushion goes from{' '}
            <strong>{(inputs.startingCashCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</strong>{' '}
            to{' '}
            <strong>{(cashAtEnd / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</strong>{' '}
            over {inputs.durationMonths} months. Rebuilding takes time.
          </div>
        )}
        {survives && shockedNet >= 0 && (
          <div className="banner success" style={{ marginTop: 12 }}>
            Even with a {inputs.incomeDropPct}% income hit and the belt-tightening you described,
            you're still cash-flow positive. The shock is uncomfortable but not threatening.
          </div>
        )}
      </div>
    </>
  );
}

const recession: ScenarioDef<Inputs> = {
  id: 'recession',
  title: 'Recession / income shock',
  subtitle: 'Stress-test the next year if income drops X% for N months.',
  category: 'life-event',
  icon: '⚠️',
  defaults,
  Form,
  Result,
};

export default recession;
