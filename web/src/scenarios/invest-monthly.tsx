import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCents } from '../format';
import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  NumberField,
  futureValueMonthly,
} from './helpers';

interface Inputs {
  startingCents: number;
  monthlyCents: number;
  years: number;
  annualReturnPct: number;
  /** marginal tax rate used to show after-tax delta for the taxable account */
  taxRatePct: number;
}

const defaults: Inputs = {
  startingCents: 0,
  monthlyCents: 50000, // $500/mo
  years: 20,
  annualReturnPct: 7,
  taxRatePct: 22,
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
      <DollarField
        label="Starting balance"
        cents={inputs.startingCents}
        onChange={(c) => onChange({ ...inputs, startingCents: c })}
      />
      <DollarField
        label="Monthly contribution"
        cents={inputs.monthlyCents}
        onChange={(c) => onChange({ ...inputs, monthlyCents: c })}
      />
      <NumberField
        label="Years invested"
        value={inputs.years}
        onChange={(n) => onChange({ ...inputs, years: n })}
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
        hint="S&P 500 long-run average is ~10% nominal / ~7% real."
      />
      <NumberField
        label="Marginal tax rate"
        value={inputs.taxRatePct}
        onChange={(n) => onChange({ ...inputs, taxRatePct: n })}
        min={0}
        max={50}
        suffix="%"
        hint="Used only to estimate the after-tax drag on a taxable brokerage."
      />
    </div>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  const months = inputs.years * 12;
  const totalContributedCents =
    inputs.startingCents + inputs.monthlyCents * months;

  const tdEnding = futureValueMonthly(
    inputs.startingCents,
    inputs.monthlyCents,
    inputs.annualReturnPct,
    months,
  );
  // Taxable: drag ~ tax_rate × dividend_yield + cap gains drag. Crude
  // simplification: shave taxRatePct% off the annual return.
  const taxableRate = inputs.annualReturnPct * (1 - inputs.taxRatePct / 100);
  const taxableEnding = futureValueMonthly(
    inputs.startingCents,
    inputs.monthlyCents,
    taxableRate,
    months,
  );

  const tdGain = tdEnding - totalContributedCents;
  const taxableGain = taxableEnding - totalContributedCents;

  const chartData = [];
  for (let y = 0; y <= inputs.years; y++) {
    chartData.push({
      year: `Y${y}`,
      'Tax-deferred': futureValueMonthly(
        inputs.startingCents,
        inputs.monthlyCents,
        inputs.annualReturnPct,
        y * 12,
      ) / 100,
      Taxable:
        futureValueMonthly(
          inputs.startingCents,
          inputs.monthlyCents,
          taxableRate,
          y * 12,
        ) / 100,
      Contributed:
        (inputs.startingCents + inputs.monthlyCents * y * 12) / 100,
    });
  }

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <CentsMetric label="Total contributed" cents={totalContributedCents} />
        <CentsMetric
          label="Tax-deferred ending"
          cents={tdEnding}
          tone="pos"
          hint={`+${formatCents(tdGain)} growth`}
        />
        <CentsMetric
          label="Taxable ending"
          cents={taxableEnding}
          tone="pos"
          hint={`+${formatCents(taxableGain)} growth`}
        />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Growth curve</h2>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey="year" minTickGap={32} />
            <YAxis tickFormatter={(v) => `$${Math.round(v / 1000)}K`} />
            <Tooltip
              formatter={(v: unknown) =>
                typeof v === 'number' ? formatCents(v * 100) : ''
              }
            />
            <Legend />
            <Line type="monotone" dataKey="Contributed" stroke="#9ca3af" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="Tax-deferred" stroke="#4f46e5" strokeWidth={2.5} dot={false} />
            <Line type="monotone" dataKey="Taxable" stroke="#10b981" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
        <p className="muted small" style={{ marginTop: 8 }}>
          Tax-deferred assumes no annual tax drag (401k/IRA/HSA).
          Taxable assumes the marginal rate shaves the same fraction off
          the annual return — a coarse approximation, not a tax model.
        </p>
      </div>
    </>
  );
}

const investMonthly: ScenarioDef<Inputs> = {
  id: 'invest-monthly',
  title: 'Invest $X/month for Y years',
  subtitle: 'Compounding curve + tax-deferred vs taxable side-by-side.',
  category: 'wealth',
  icon: '📈',
  defaults,
  Form,
  Result,
};

export default investMonthly;
