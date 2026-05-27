import { useState } from 'react';
import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  NumberField,
  monthlyPayment,
  monthsToPayoff,
  totalInterest,
  yearsMonthsLabel,
} from './helpers';

interface DebtRow {
  balance: number;
  apr: number;
  payment: number;
}

interface Inputs {
  debts: DebtRow[];
  consolidationAprPct: number;
  consolidationMonths: number;
  originationFeePct: number;
}

const defaults: Inputs = {
  debts: [
    { balance: 500000, apr: 24, payment: 15000 },
    { balance: 300000, apr: 19, payment: 9000 },
  ],
  consolidationAprPct: 9.5,
  consolidationMonths: 60,
  originationFeePct: 2,
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  const [draft] = useState({ balance: '', apr: '', payment: '' });
  function addDebt() {
    onChange({
      ...inputs,
      debts: [...inputs.debts, { balance: 0, apr: 20, payment: 5000 }],
    });
  }
  function removeDebt(i: number) {
    onChange({ ...inputs, debts: inputs.debts.filter((_, j) => j !== i) });
  }
  function updateDebt(i: number, patch: Partial<DebtRow>) {
    const next = [...inputs.debts];
    next[i] = { ...next[i]!, ...patch };
    onChange({ ...inputs, debts: next });
  }
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Today's debts</h3>
      {inputs.debts.map((d, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr auto',
            gap: 8,
            alignItems: 'end',
            marginBottom: 6,
          }}
        >
          <DollarField
            label={i === 0 ? 'Balance' : ''}
            cents={d.balance}
            onChange={(c) => updateDebt(i, { balance: c })}
          />
          <NumberField
            label={i === 0 ? 'APR' : ''}
            value={d.apr}
            onChange={(n) => updateDebt(i, { apr: n })}
            min={0}
            max={40}
            step={0.5}
            suffix="%"
          />
          <DollarField
            label={i === 0 ? 'Monthly payment' : ''}
            cents={d.payment}
            onChange={(c) => updateDebt(i, { payment: c })}
          />
          <button
            type="button"
            className="btn-link"
            onClick={() => removeDebt(i)}
            style={{ marginBottom: 9 }}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn secondary" onClick={addDebt}>
        + Add debt
      </button>
      <h3 style={{ marginTop: 16 }}>Consolidation loan</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <NumberField
          label="Loan APR"
          value={inputs.consolidationAprPct}
          onChange={(n) => onChange({ ...inputs, consolidationAprPct: n })}
          min={0}
          max={30}
          step={0.25}
          suffix="%"
          hint="Personal loan or HELOC rate."
        />
        <NumberField
          label="Loan term"
          value={inputs.consolidationMonths}
          onChange={(n) => onChange({ ...inputs, consolidationMonths: n })}
          min={12}
          max={240}
          suffix="months"
        />
        <NumberField
          label="Origination fee"
          value={inputs.originationFeePct}
          onChange={(n) => onChange({ ...inputs, originationFeePct: n })}
          min={0}
          max={10}
          step={0.25}
          suffix="% of loan"
        />
      </div>
    </>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  // Baseline: keep paying each debt with its current min payment.
  let baseInterest = 0;
  let baseMonths = 0;
  let baseUnpayable = false;
  for (const d of inputs.debts) {
    const m = monthsToPayoff(d.balance, d.apr, d.payment);
    if (m === null) {
      baseUnpayable = true;
      continue;
    }
    baseMonths = Math.max(baseMonths, m);
    baseInterest += totalInterest(d.balance, d.apr, d.payment, m);
  }

  // Consolidation: roll all balances into one loan.
  const totalBalance = inputs.debts.reduce((s, d) => s + d.balance, 0);
  const fee = Math.round((totalBalance * inputs.originationFeePct) / 100);
  const consolidatedPrincipal = totalBalance + fee;
  const consolidatedPayment = monthlyPayment(
    consolidatedPrincipal,
    inputs.consolidationAprPct,
    inputs.consolidationMonths,
  );
  const consolidatedInterest = totalInterest(
    consolidatedPrincipal,
    inputs.consolidationAprPct,
    consolidatedPayment,
    inputs.consolidationMonths,
  );

  const currentTotalPayment = inputs.debts.reduce((s, d) => s + d.payment, 0);
  const paymentDelta = consolidatedPayment - currentTotalPayment;
  const interestSaved = baseInterest - consolidatedInterest - fee;

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Keep current debts</h3>
          {baseUnpayable && (
            <div className="banner warning" style={{ marginBottom: 8 }}>
              At least one debt's payment doesn't cover interest — that debt won't be paid off at the current rate.
            </div>
          )}
          <CentsMetric label="Total balance" cents={totalBalance} />
          <CentsMetric label="Combined monthly payment" cents={currentTotalPayment} />
          <CentsMetric label="Payoff time (longest)" cents={0} hint={baseMonths > 0 ? yearsMonthsLabel(baseMonths) : '—'} />
          <CentsMetric label="Total interest" cents={baseInterest} tone="neg" />
        </div>
        <div className="card" style={{ background: 'var(--accent-soft)' }}>
          <h3 style={{ marginTop: 0 }}>Consolidate at {inputs.consolidationAprPct}%</h3>
          <CentsMetric label="Loan amount" cents={consolidatedPrincipal} hint={`Includes ${(inputs.originationFeePct).toFixed(2)}% origination fee`} />
          <CentsMetric label="Monthly payment" cents={consolidatedPayment} />
          <CentsMetric label="Payoff time" cents={0} hint={yearsMonthsLabel(inputs.consolidationMonths)} />
          <CentsMetric label="Total interest + fee" cents={consolidatedInterest + fee} />
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Verdict</h3>
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <CentsMetric
            label="Interest saved"
            cents={interestSaved}
            tone={interestSaved > 0 ? 'pos' : 'neg'}
          />
          <CentsMetric
            label="Monthly payment change"
            cents={paymentDelta}
            tone={paymentDelta < 0 ? 'pos' : 'warn'}
            hint={paymentDelta < 0 ? 'Lower monthly outlay' : 'Higher monthly outlay'}
          />
        </div>
      </div>
    </>
  );
}

const debtConsolidation: ScenarioDef<Inputs> = {
  id: 'debt-consolidation',
  title: 'Consolidate at one rate',
  subtitle: 'Roll multiple debts into a single loan — does the math work?',
  category: 'debt',
  icon: '🧮',
  defaults,
  Form,
  Result,
};

export default debtConsolidation;
