import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  NumberField,
  futureValueMonthly,
} from './helpers';

interface Inputs {
  takeHomeAnnualCents: number;
  annualSpendCents: number;
  startingPortfolioCents: number;
  annualReturnPct: number;
  withdrawalRatePct: number;
}

const defaults: Inputs = {
  takeHomeAnnualCents: 10000000, // $100k take-home
  annualSpendCents: 6000000, // $60k spend
  startingPortfolioCents: 5000000, // $50k portfolio
  annualReturnPct: 7,
  withdrawalRatePct: 4,
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
      <DollarField
        label="Annual take-home pay"
        cents={inputs.takeHomeAnnualCents}
        onChange={(c) => onChange({ ...inputs, takeHomeAnnualCents: c })}
        hint="After taxes and pre-tax retirement contributions."
      />
      <DollarField
        label="Annual spending"
        cents={inputs.annualSpendCents}
        onChange={(c) => onChange({ ...inputs, annualSpendCents: c })}
        hint="What you actually live on per year."
      />
      <DollarField
        label="Current portfolio"
        cents={inputs.startingPortfolioCents}
        onChange={(c) => onChange({ ...inputs, startingPortfolioCents: c })}
      />
      <NumberField
        label="Expected annual return"
        value={inputs.annualReturnPct}
        onChange={(n) => onChange({ ...inputs, annualReturnPct: n })}
        min={0}
        max={20}
        step={0.5}
        suffix="%"
      />
      <NumberField
        label="Safe withdrawal rate"
        value={inputs.withdrawalRatePct}
        onChange={(n) => onChange({ ...inputs, withdrawalRatePct: n })}
        min={2}
        max={8}
        step={0.25}
        suffix="%"
        hint="The Trinity 4% rule is the classic. 3% is more conservative."
      />
    </div>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const annualSavings = inputs.takeHomeAnnualCents - inputs.annualSpendCents;
  const monthlySavings = annualSavings / 12;
  const saveRate =
    inputs.takeHomeAnnualCents > 0
      ? annualSavings / inputs.takeHomeAnnualCents
      : 0;

  // FIRE number = annual spend / SWR
  const fireNumber =
    inputs.withdrawalRatePct > 0
      ? Math.round((inputs.annualSpendCents * 100) / inputs.withdrawalRatePct)
      : 0;

  // Find the smallest N (months) such that future value >= fire number.
  let yearsToFire: number | null = null;
  if (annualSavings <= 0) {
    yearsToFire = null;
  } else {
    for (let y = 1; y <= 60; y++) {
      const ending = futureValueMonthly(
        inputs.startingPortfolioCents,
        monthlySavings,
        inputs.annualReturnPct,
        y * 12,
      );
      if (ending >= fireNumber) {
        yearsToFire = y;
        break;
      }
    }
  }

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <CentsMetric
          label="Annual savings"
          cents={annualSavings}
          tone={annualSavings > 0 ? 'pos' : 'neg'}
          hint={`${Math.round(saveRate * 100)}% save rate`}
        />
        <CentsMetric label="FIRE number" cents={fireNumber} hint={`Portfolio that supports ${inputs.withdrawalRatePct}% withdrawal`} />
        <CentsMetric
          label="Distance to FIRE"
          cents={Math.max(0, fireNumber - inputs.startingPortfolioCents)}
          tone="warn"
        />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Time to financial independence</h3>
        {annualSavings <= 0 ? (
          <p className="banner error">
            Your spending exceeds your take-home pay — there's nothing left to invest.
            FIRE math doesn't work until savings is positive.
          </p>
        ) : yearsToFire === null ? (
          <p className="banner warning">
            At this save rate + return, the portfolio doesn't reach the FIRE number
            within 60 years. Try increasing savings or returns.
          </p>
        ) : (
          <>
            <CentsMetric
              label={`Years to FIRE`}
              cents={0}
              tone="pos"
            />
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: -36, marginLeft: 8 }}>
              {yearsToFire} years
            </div>
            <p className="muted small" style={{ marginTop: 12 }}>
              Saving {(saveRate * 100).toFixed(0)}% of take-home with{' '}
              {inputs.annualReturnPct}% returns means in {yearsToFire} years you'll
              reach a portfolio that produces {inputs.withdrawalRatePct}% × portfolio
              = your annual spend.
            </p>
          </>
        )}
      </div>
    </>
  );
}

const fireDate: ScenarioDef<Inputs> = {
  id: 'fire-date',
  title: 'FIRE date',
  subtitle: 'Given your save rate, when does your portfolio cover annual expenses?',
  category: 'wealth',
  icon: '🔥',
  defaults,
  Form,
  Result,
};

export default fireDate;
