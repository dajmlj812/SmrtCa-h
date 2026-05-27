import type { ScenarioDef } from './types';
import {
  CentsMetric,
  DollarField,
  NumberField,
  monthsToPayoff,
  totalInterest,
  yearsMonthsLabel,
} from './helpers';

interface Inputs {
  balanceCents: number;
  currentAprPct: number;
  paymentCents: number;
  promoAprPct: number;
  promoMonths: number;
  postPromoAprPct: number;
  transferFeePct: number;
}

const defaults: Inputs = {
  balanceCents: 800000, // $8,000
  currentAprPct: 22,
  paymentCents: 25000, // $250/mo
  promoAprPct: 0,
  promoMonths: 18,
  postPromoAprPct: 22,
  transferFeePct: 3,
};

function Form({ inputs, onChange }: { inputs: Inputs; onChange: (i: Inputs) => void }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Today's debt</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <DollarField
          label="Balance"
          cents={inputs.balanceCents}
          onChange={(c) => onChange({ ...inputs, balanceCents: c })}
        />
        <NumberField
          label="Current APR"
          value={inputs.currentAprPct}
          onChange={(n) => onChange({ ...inputs, currentAprPct: n })}
          min={0}
          max={40}
          step={0.5}
          suffix="%"
        />
        <DollarField
          label="Monthly payment"
          cents={inputs.paymentCents}
          onChange={(c) => onChange({ ...inputs, paymentCents: c })}
        />
      </div>
      <h3 style={{ marginTop: 12 }}>Balance-transfer offer</h3>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <NumberField
          label="Promo APR"
          value={inputs.promoAprPct}
          onChange={(n) => onChange({ ...inputs, promoAprPct: n })}
          min={0}
          max={20}
          step={0.5}
          suffix="%"
        />
        <NumberField
          label="Promo length"
          value={inputs.promoMonths}
          onChange={(n) => onChange({ ...inputs, promoMonths: n })}
          min={1}
          max={36}
          suffix="months"
        />
        <NumberField
          label="Post-promo APR"
          value={inputs.postPromoAprPct}
          onChange={(n) => onChange({ ...inputs, postPromoAprPct: n })}
          min={0}
          max={40}
          step={0.5}
          suffix="%"
          hint="Where the rate snaps back if there's a remaining balance."
        />
        <NumberField
          label="Transfer fee"
          value={inputs.transferFeePct}
          onChange={(n) => onChange({ ...inputs, transferFeePct: n })}
          min={0}
          max={10}
          step={0.5}
          suffix="% of balance"
        />
      </div>
    </>
  );
}

function Result({ inputs }: { inputs: Inputs }) {
  // Baseline: stay on current card.
  const baseMonths = monthsToPayoff(inputs.balanceCents, inputs.currentAprPct, inputs.paymentCents);
  const baseInterest =
    baseMonths === null
      ? null
      : totalInterest(inputs.balanceCents, inputs.currentAprPct, inputs.paymentCents, baseMonths);

  // Transfer path: balance becomes balance + fee, runs at promo APR for promoMonths,
  // then any remaining balance accrues at postPromoAprPct.
  const fee = Math.round((inputs.balanceCents * inputs.transferFeePct) / 100);
  const transferredBalance = inputs.balanceCents + fee;
  // Simulate the promo period.
  let bal = transferredBalance;
  let interestPaidPromo = 0;
  const promoRate = inputs.promoAprPct / 100 / 12;
  let promoEnd = 0;
  for (let m = 0; m < inputs.promoMonths && bal > 0; m++) {
    const interest = Math.round(bal * promoRate);
    const principal = Math.min(bal, inputs.paymentCents - interest);
    if (principal <= 0) break;
    interestPaidPromo += interest;
    bal -= principal;
    promoEnd = m + 1;
  }
  // Remaining at end of promo.
  const remainingAtPromoEnd = Math.max(0, bal);
  const postPromoMonths =
    remainingAtPromoEnd > 0
      ? monthsToPayoff(remainingAtPromoEnd, inputs.postPromoAprPct, inputs.paymentCents)
      : 0;
  const postPromoInterest =
    postPromoMonths === null
      ? null
      : totalInterest(remainingAtPromoEnd, inputs.postPromoAprPct, inputs.paymentCents, postPromoMonths);

  const transferTotalMonths =
    postPromoMonths === null ? null : promoEnd + postPromoMonths;
  const transferTotalInterest =
    postPromoInterest === null ? null : interestPaidPromo + postPromoInterest;
  const transferTotalCost =
    transferTotalInterest === null ? null : transferTotalInterest + fee;

  const monthsSaved =
    baseMonths !== null && transferTotalMonths !== null ? baseMonths - transferTotalMonths : null;
  const interestSaved =
    baseInterest !== null && transferTotalCost !== null ? baseInterest - transferTotalCost : null;

  return (
    <>
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Stay on current card</h3>
          <CentsMetric label="Payoff time" cents={0} hint={baseMonths === null ? '—' : yearsMonthsLabel(baseMonths)} />
          <CentsMetric label="Total interest" cents={baseInterest ?? 0} tone="neg" />
        </div>
        <div className="card" style={{ background: 'var(--accent-soft)' }}>
          <h3 style={{ marginTop: 0 }}>Transfer at {inputs.promoAprPct}% for {inputs.promoMonths} mo</h3>
          <CentsMetric label="Transfer fee" cents={fee} hint={`${inputs.transferFeePct}% of balance`} />
          <CentsMetric
            label="Payoff time"
            cents={0}
            hint={transferTotalMonths === null ? '—' : yearsMonthsLabel(transferTotalMonths)}
          />
          <CentsMetric label="Total interest + fee" cents={transferTotalCost ?? 0} />
          {remainingAtPromoEnd > 0 && (
            <p className="muted small" style={{ marginTop: 6 }}>
              Balance at end of promo: <strong>{(remainingAtPromoEnd / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</strong>
              — accrues at {inputs.postPromoAprPct}% after.
            </p>
          )}
        </div>
      </div>
      {monthsSaved !== null && interestSaved !== null && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Verdict</h3>
          <CentsMetric
            label="Interest saved by transferring"
            cents={interestSaved}
            tone={interestSaved > 0 ? 'pos' : 'neg'}
            hint={
              interestSaved > 0
                ? 'Transfer saves money even after the fee.'
                : `Transfer costs more — the ${inputs.transferFeePct}% fee + post-promo APR outweigh the promo savings at your payment level.`
            }
          />
        </div>
      )}
    </>
  );
}

const balanceTransfer: ScenarioDef<Inputs> = {
  id: 'balance-transfer',
  title: 'Balance transfer offer',
  subtitle: 'Does the promo APR beat the transfer fee + post-promo rate?',
  category: 'debt',
  icon: '🔁',
  defaults,
  Form,
  Result,
};

export default balanceTransfer;
