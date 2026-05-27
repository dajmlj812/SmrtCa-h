import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  Metric,
  NumberField,
  monthlyPayment,
} from './helpers';

interface Inputs {
  purchasePriceCents: number;
  downPaymentPct: number;
  mortgageAprPct: number;
  termYears: number;
  propertyTaxAnnualPct: number;
  insuranceAnnualPct: number;
  hoaMonthlyCents: number;
  pmiAnnualPct: number;
  grossMonthlyIncomeCents: number;
  monthlyDebtCents: number;
}

const defaults: Inputs = {
  purchasePriceCents: 40000000, // $400k
  downPaymentPct: 10,
  mortgageAprPct: 6.5,
  termYears: 30,
  propertyTaxAnnualPct: 1.1,
  insuranceAnnualPct: 0.35,
  hoaMonthlyCents: 0,
  pmiAnnualPct: 0.6,
  grossMonthlyIncomeCents: 850000, // $8,500/mo gross
  monthlyDebtCents: 50000, // $500/mo other debt
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>House</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <DollarField
          label="Purchase price"
          cents={inputs.purchasePriceCents}
          onChange={(c) => onChange({ ...inputs, purchasePriceCents: c })}
        />
        <NumberField
          label="Down payment"
          value={inputs.downPaymentPct}
          onChange={(n) => onChange({ ...inputs, downPaymentPct: n })}
          min={0}
          max={100}
          step={0.5}
          suffix="%"
        />
      </div>
      <h3 style={{ marginTop: 12 }}>Loan</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <NumberField
          label="Mortgage APR"
          value={inputs.mortgageAprPct}
          onChange={(n) => onChange({ ...inputs, mortgageAprPct: n })}
          min={0}
          max={15}
          step={0.125}
          suffix="%"
        />
        <NumberField
          label="Term"
          value={inputs.termYears}
          onChange={(n) => onChange({ ...inputs, termYears: n })}
          min={10}
          max={40}
          suffix="yrs"
        />
      </div>
      <h3 style={{ marginTop: 12 }}>Carrying costs</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <NumberField
          label="Property tax"
          value={inputs.propertyTaxAnnualPct}
          onChange={(n) => onChange({ ...inputs, propertyTaxAnnualPct: n })}
          min={0}
          max={5}
          step={0.05}
          suffix="% of price/yr"
        />
        <NumberField
          label="Homeowners insurance"
          value={inputs.insuranceAnnualPct}
          onChange={(n) => onChange({ ...inputs, insuranceAnnualPct: n })}
          min={0}
          max={2}
          step={0.05}
          suffix="% of price/yr"
        />
        <DollarField
          label="HOA dues"
          cents={inputs.hoaMonthlyCents}
          onChange={(c) => onChange({ ...inputs, hoaMonthlyCents: c })}
          hint="Per month."
        />
        <NumberField
          label="PMI (if <20% down)"
          value={inputs.pmiAnnualPct}
          onChange={(n) => onChange({ ...inputs, pmiAnnualPct: n })}
          min={0}
          max={2}
          step={0.05}
          suffix="% of loan/yr"
        />
      </div>
      <h3 style={{ marginTop: 12 }}>Your finances</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <DollarField
          label="Gross monthly income"
          cents={inputs.grossMonthlyIncomeCents}
          onChange={(c) => onChange({ ...inputs, grossMonthlyIncomeCents: c })}
        />
        <DollarField
          label="Other monthly debt"
          cents={inputs.monthlyDebtCents}
          onChange={(c) => onChange({ ...inputs, monthlyDebtCents: c })}
          hint="Car loans, student loans, min credit card payments."
        />
      </div>
    </>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const downPayment = Math.round((inputs.purchasePriceCents * inputs.downPaymentPct) / 100);
  const loanAmount = inputs.purchasePriceCents - downPayment;
  const piMonthly = monthlyPayment(
    loanAmount,
    inputs.mortgageAprPct,
    inputs.termYears * 12,
  );
  const taxMonthly = Math.round(
    (inputs.purchasePriceCents * inputs.propertyTaxAnnualPct) / 100 / 12,
  );
  const insMonthly = Math.round(
    (inputs.purchasePriceCents * inputs.insuranceAnnualPct) / 100 / 12,
  );
  const pmiMonthly =
    inputs.downPaymentPct < 20
      ? Math.round((loanAmount * inputs.pmiAnnualPct) / 100 / 12)
      : 0;
  const pitiTotal = piMonthly + taxMonthly + insMonthly + inputs.hoaMonthlyCents + pmiMonthly;

  const frontEndRatio =
    inputs.grossMonthlyIncomeCents > 0
      ? pitiTotal / inputs.grossMonthlyIncomeCents
      : 0;
  const backEndRatio =
    inputs.grossMonthlyIncomeCents > 0
      ? (pitiTotal + inputs.monthlyDebtCents) / inputs.grossMonthlyIncomeCents
      : 0;
  const cashNeeded = downPayment + Math.round(inputs.purchasePriceCents * 0.03); // ~3% closing

  const verdict = (() => {
    if (backEndRatio < 0.36 && frontEndRatio < 0.28) {
      return { tone: 'pos' as const, text: 'Comfortable — both DTI ratios sit inside the conventional comfort zone.' };
    }
    if (backEndRatio < 0.43) {
      return {
        tone: 'warn' as const,
        text: `Stretched — your back-end DTI of ${Math.round(backEndRatio * 100)}% is over 36% but under 43% (the upper limit most lenders allow). Doable, not roomy.`,
      };
    }
    return {
      tone: 'neg' as const,
      text: `Over budget — back-end DTI of ${Math.round(backEndRatio * 100)}% exceeds the 43% cap most conforming lenders will go to. Lenders are likely to decline at this price.`,
    };
  })();

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <CentsMetric label="Cash at closing" cents={cashNeeded} hint="Down payment + ~3% closing costs" />
        <CentsMetric label="Loan amount" cents={loanAmount} />
        <CentsMetric label="Monthly PITI + HOA + PMI" cents={pitiTotal} tone="warn" />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Monthly payment breakdown</h3>
        <table className="apikeys-table">
          <tbody>
            <tr>
              <td>Principal + interest</td>
              <td className="num">{(piMonthly / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</td>
            </tr>
            <tr>
              <td>Property tax</td>
              <td className="num">{(taxMonthly / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</td>
            </tr>
            <tr>
              <td>Insurance</td>
              <td className="num">{(insMonthly / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</td>
            </tr>
            {inputs.hoaMonthlyCents > 0 && (
              <tr>
                <td>HOA</td>
                <td className="num">{(inputs.hoaMonthlyCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</td>
              </tr>
            )}
            {pmiMonthly > 0 && (
              <tr>
                <td>PMI</td>
                <td className="num">{(pmiMonthly / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</td>
              </tr>
            )}
            <tr style={{ fontWeight: 700 }}>
              <td>Total</td>
              <td className="num">{(pitiTotal / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Affordability</h3>
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Metric
            label="Front-end DTI"
            value={`${Math.round(frontEndRatio * 100)}%`}
            tone={frontEndRatio < 0.28 ? 'pos' : frontEndRatio < 0.31 ? 'warn' : 'neg'}
            hint="Housing only / gross income. Lenders like <28%."
          />
          <Metric
            label="Back-end DTI"
            value={`${Math.round(backEndRatio * 100)}%`}
            tone={backEndRatio < 0.36 ? 'pos' : backEndRatio < 0.43 ? 'warn' : 'neg'}
            hint="All debt / gross income. Conventional cap is 43%."
          />
        </div>
        <div className={`banner ${verdict.tone === 'pos' ? 'success' : verdict.tone === 'warn' ? 'warning' : 'error'}`} style={{ marginTop: 12 }}>
          {verdict.text}
        </div>
      </div>
    </>
  );
}

const buyHouse: ScenarioDef<Inputs> = {
  id: 'buy-house',
  title: 'Buy a house',
  subtitle: 'Affordability check: PITI, DTI ratios, cash to close.',
  category: 'life-event',
  icon: '🏡',
  defaults,
  Form,
  Result,
};

export default buyHouse;
