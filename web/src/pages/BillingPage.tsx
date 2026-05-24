import { useEffect, useState } from 'react';
import {
  api,
  type BillingStatus,
  type Plan,
  type PlanLookupKey,
  type SubscriptionStatus,
} from '../api.js';

/**
 * 0.15.3 — Billing page.
 *
 * One page covering everything a paying tenant might want to do:
 *   - See their current plan + status + trial countdown
 *   - Watch usage meters for the metered features (AI assistant, OCR)
 *     and the hard caps (bank connections, household members)
 *   - Change plan (kicks them through Stripe Checkout for the new tier)
 *   - Manage payment method / invoices / cancel (Stripe Customer Portal)
 *
 * When the tenant has no subscription at all (`plan === null`), the
 * page becomes a plan selector — pick a tier, start a trial, get
 * dropped into Stripe Checkout.
 */

const PLAN_LABEL: Record<Plan, string> = {
  starter: 'SmrtCash Starter',
  plus: 'SmrtCash Plus',
  family: 'SmrtCash Family',
};
const PLAN_BLURB: Record<Plan, string> = {
  starter: 'Manual budgeting + file import. Unlimited accounts.',
  plus: 'Bank sync, AI assistant, OCR, anomaly alerts, tax reports, crypto, multi-currency, retirement projections.',
  family: 'Everything in Plus, up to 6 household members with per-account permissions, bill splitting, unlimited AI + OCR.',
};
const PLAN_PRICE_ANNUAL: Record<Plan, number> = { starter: 59, plus: 99, family: 149 };
const PLAN_PRICE_MONTHLY: Record<Plan, number> = { starter: 7.99, plus: 13.99, family: 19.99 };

function StatusPill({ status }: { status: SubscriptionStatus | null }) {
  if (!status) return <span className="badge muted">No subscription</span>;
  const variant: Record<SubscriptionStatus, string> = {
    trialing: 'info',
    active: 'success',
    past_due: 'warn',
    canceled: 'muted',
    incomplete: 'warn',
    incomplete_expired: 'muted',
    unpaid: 'warn',
    paused: 'muted',
  };
  const label = status.replace(/_/g, ' ');
  return <span className={`badge ${variant[status]}`}>{label}</span>;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / 86400_000);
}

function fmtPct(used: number, cap: number): string {
  if (cap === 0) return '0%';
  return `${Math.min(100, Math.round((used / cap) * 100))}%`;
}

function MeterRow({
  label,
  used,
  cap,
  unit,
}: {
  label: string;
  used: number;
  cap: number | null;
  unit?: string;
}) {
  // Unlimited (cap=null) renders as "Unlimited" — no bar.
  if (cap === null) {
    return (
      <div className="meter-row">
        <div className="meter-label">
          <span>{label}</span>
          <span className="meter-value">
            {used}
            {unit && ` ${unit}`} · Unlimited
          </span>
        </div>
      </div>
    );
  }
  const pct = cap === 0 ? 0 : Math.min(100, (used / cap) * 100);
  const danger = pct >= 90;
  const warn = !danger && pct >= 75;
  return (
    <div className="meter-row">
      <div className="meter-label">
        <span>{label}</span>
        <span className="meter-value">
          {used} / {cap}
          {unit && ` ${unit}`} ({fmtPct(used, cap)})
        </span>
      </div>
      <div className="meter-bar">
        <div
          className={`meter-fill ${danger ? 'danger' : warn ? 'warn' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function BillingPage() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const s = await api.getBillingStatus();
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function startCheckout(lookupKey: PlanLookupKey) {
    setActing(lookupKey);
    setError(null);
    try {
      const r = await api.startBillingCheckout(lookupKey);
      window.location.href = r.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActing(null);
    }
  }

  async function openPortal() {
    setActing('portal');
    setError(null);
    try {
      const r = await api.openBillingPortal();
      window.location.href = r.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActing(null);
    }
  }

  if (loading && !status) {
    return (
      <div className="page-content">
        <h1>Billing</h1>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const trialDays = status?.status === 'trialing' ? daysUntil(status.trialEnd) : null;
  const renewalDays = status?.status === 'active' ? daysUntil(status.currentPeriodEnd) : null;

  return (
    <div className="page-content billing-page">
      <header className="page-header">
        <h1>Billing</h1>
        {status?.plan && <StatusPill status={status.status} />}
      </header>

      {error && (
        <div className="card danger" role="alert">
          {error}
        </div>
      )}

      {/* Current plan card */}
      {status?.plan ? (
        <section className="card">
          <h2>{PLAN_LABEL[status.plan]}</h2>
          <p className="muted">{PLAN_BLURB[status.plan]}</p>

          {trialDays !== null && trialDays > 0 && (
            <p className="callout info">
              <strong>Free trial</strong> — {trialDays} day{trialDays === 1 ? '' : 's'} remaining.
              You won't be charged until {new Date(status.trialEnd!).toLocaleDateString()}.
            </p>
          )}
          {renewalDays !== null && renewalDays > 0 && status.currentPeriodEnd && (
            <p className="muted small">
              Renews {new Date(status.currentPeriodEnd).toLocaleDateString()}{' '}
              ({renewalDays} day{renewalDays === 1 ? '' : 's'} from now).
            </p>
          )}
          {status.cancelAtPeriodEnd && status.currentPeriodEnd && (
            <p className="callout warn">
              Your subscription will end on{' '}
              {new Date(status.currentPeriodEnd).toLocaleDateString()}. Re-enable in
              the billing portal to keep your features.
            </p>
          )}
          {status.status === 'past_due' && (
            <p className="callout warn">
              We couldn't process your last payment. Update your payment method
              in the billing portal to keep your subscription active.
            </p>
          )}

          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={acting !== null}
              onClick={openPortal}
            >
              {acting === 'portal' ? 'Opening…' : 'Manage billing'}
            </button>
            {!status.hasStripeCustomer && (
              <p className="muted small">
                Billing portal becomes available after your first paid period.
              </p>
            )}
          </div>
        </section>
      ) : (
        <section className="card">
          <h2>Pick a plan to get started</h2>
          <p className="muted">
            All plans include a 14-day free trial. No card required upfront.
          </p>
        </section>
      )}

      {/* Usage meters — only meaningful with a plan */}
      {status?.plan && (
        <section className="card">
          <h3>Usage this period</h3>
          <MeterRow
            label="AI assistant calls"
            used={status.usage.aiAssistant.used}
            cap={status.usage.aiAssistant.cap}
            unit="calls"
          />
          <MeterRow
            label="Receipt OCR"
            used={status.usage.receiptOcr.used}
            cap={status.usage.receiptOcr.cap}
            unit="receipts"
          />
          <MeterRow
            label="Bank connections"
            used={status.caps.bankConnections.used}
            cap={status.caps.bankConnections.cap}
            unit="institutions"
          />
          <MeterRow
            label="Household members"
            used={status.caps.householdMembers.used}
            cap={status.caps.householdMembers.cap}
            unit="seats"
          />
        </section>
      )}

      {/* Plan comparison + change-plan buttons */}
      <section className="card">
        <h3>{status?.plan ? 'Change plan' : 'Available plans'}</h3>
        <div className="plan-grid">
          {(['starter', 'plus', 'family'] as const).map((p) => {
            const current = status?.plan === p;
            return (
              <div key={p} className={`plan-card ${current ? 'current' : ''}`}>
                <h4>{PLAN_LABEL[p]}</h4>
                <p className="plan-price">
                  <strong>${PLAN_PRICE_ANNUAL[p]}</strong>/yr
                  <span className="muted small">
                    {' '}or ${PLAN_PRICE_MONTHLY[p].toFixed(2)}/mo
                  </span>
                </p>
                <p className="plan-blurb">{PLAN_BLURB[p]}</p>
                {current ? (
                  <button className="btn secondary" disabled>
                    Current plan
                  </button>
                ) : (
                  <div className="plan-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={acting !== null}
                      onClick={() => startCheckout(`${p}_annual` as PlanLookupKey)}
                    >
                      {acting === `${p}_annual` ? 'Opening…' : 'Pick annual'}
                    </button>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={acting !== null}
                      onClick={() => startCheckout(`${p}_monthly` as PlanLookupKey)}
                    >
                      {acting === `${p}_monthly` ? 'Opening…' : 'Pick monthly'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
