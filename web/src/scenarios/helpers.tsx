import type { ReactNode } from 'react';
import { formatCents } from '../format';

/**
 * 0.24.0 — Shared bits used across scenario modules. Kept here
 * so each scenario file stays focused on its math.
 */

export function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: 'pos' | 'neg' | 'warn';
  hint?: string;
}) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 13 }}>
        {label}
      </div>
      <div
        style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}
        className={
          tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : tone === 'warn' ? 'warn' : ''
        }
      >
        {value}
      </div>
      {hint && (
        <div className="muted small" style={{ marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function CentsMetric({
  label,
  cents,
  tone,
  hint,
}: {
  label: string;
  cents: number;
  tone?: 'pos' | 'neg' | 'warn';
  hint?: string;
}) {
  return <Metric label={label} value={formatCents(cents)} tone={tone} hint={hint} />;
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  hint?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="number"
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? n : 0);
          }}
          style={{ flex: 1 }}
        />
        {suffix && <span className="muted small">{suffix}</span>}
      </div>
      {hint && <div className="muted small" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function DollarField({
  label,
  cents,
  onChange,
  hint,
}: {
  label: string;
  cents: number;
  onChange: (cents: number) => void;
  hint?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="muted small">$</span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={cents === 0 ? '' : (cents / 100).toFixed(2)}
          placeholder="0.00"
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') {
              onChange(0);
            } else {
              const n = Math.round(Number(v) * 100);
              onChange(Number.isFinite(n) ? n : 0);
            }
          }}
          style={{ flex: 1 }}
        />
      </div>
      {hint && <div className="muted small" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

/**
 * Future-value of a series of monthly contributions at annual
 * rate r%, compounded monthly, with optional starting principal.
 * Returns ending balance in cents.
 */
export function futureValueMonthly(
  startCents: number,
  monthlyCents: number,
  annualPct: number,
  months: number,
): number {
  const monthlyRate = annualPct / 100 / 12;
  if (monthlyRate === 0) {
    return startCents + monthlyCents * months;
  }
  const fvPrincipal = startCents * Math.pow(1 + monthlyRate, months);
  const fvSeries =
    monthlyCents *
    ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
  return Math.round(fvPrincipal + fvSeries);
}

/**
 * Standard amortization payment for a loan of P principal at
 * annual r% over N total months.
 */
export function monthlyPayment(
  principalCents: number,
  annualPct: number,
  months: number,
): number {
  if (months <= 0 || principalCents <= 0) return 0;
  const r = annualPct / 100 / 12;
  if (r === 0) return Math.round(principalCents / months);
  const pmt =
    (principalCents * r * Math.pow(1 + r, months)) /
    (Math.pow(1 + r, months) - 1);
  return Math.round(pmt);
}

/**
 * Months to pay off a loan paying `paymentCents` per month at
 * annual r%. Returns null if the payment doesn't cover interest.
 */
export function monthsToPayoff(
  balanceCents: number,
  annualPct: number,
  paymentCents: number,
): number | null {
  if (balanceCents <= 0) return 0;
  if (paymentCents <= 0) return null;
  const r = annualPct / 100 / 12;
  if (r === 0) return Math.ceil(balanceCents / paymentCents);
  if (paymentCents <= balanceCents * r) return null; // payment < monthly interest
  const n = -Math.log(1 - (balanceCents * r) / paymentCents) / Math.log(1 + r);
  return Math.ceil(n);
}

/**
 * Total interest paid over `months` at `paymentCents`/mo on a
 * starting principal at annual r%.
 */
export function totalInterest(
  balanceCents: number,
  annualPct: number,
  paymentCents: number,
  months: number,
): number {
  let bal = balanceCents;
  let interestPaid = 0;
  const r = annualPct / 100 / 12;
  for (let m = 0; m < months && bal > 0; m++) {
    const interest = Math.round(bal * r);
    const principal = Math.min(bal, paymentCents - interest);
    if (principal <= 0) return interestPaid; // payment doesn't cover interest
    interestPaid += interest;
    bal -= principal;
  }
  return interestPaid;
}

export function yearsMonthsLabel(totalMonths: number): string {
  const y = Math.floor(totalMonths / 12);
  const m = totalMonths % 12;
  if (y === 0) return `${m} mo`;
  if (m === 0) return `${y} yr${y === 1 ? '' : 's'}`;
  return `${y} yr${y === 1 ? '' : 's'} ${m} mo`;
}
