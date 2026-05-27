import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type Account,
  type BudgetPeriodSummary,
  type BudgetPeriodType,
  type BudgetPlan,
} from '../api';
import { formatCents, formatDate } from '../format';
import { BudgetWizard } from '../components/BudgetWizard';

/**
 * 0.21.8 — Paycheck-to-Paycheck Budget (the second of two pages
 * the previous /budgets was split into).
 *
 * Each plan lays out one income period from "paycheck arrives" to
 * "leftover at end of period," with bills, set-aside categories,
 * and the net per cycle. For per-category calendar-month
 * actuals see /monthly-budget.
 */

const PERIOD_LABELS: Record<BudgetPeriodType, string> = {
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  semimonthly: 'Semi-monthly',
  monthly: 'Monthly',
  custom: 'Custom',
};

export function PaycheckBudgetPage() {
  const [periods, setPeriods] = useState<BudgetPeriodSummary[]>([]);
  const [accountsList, setAccountsList] = useState<Account[]>([]);
  const [plans, setPlans] = useState<BudgetPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [wizardSummary, setWizardSummary] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [periodsArr, accts, plansArr] = await Promise.all([
        api.budgetPeriods(),
        api.listAccounts(),
        api.listBudgetPlans(),
      ]);
      setPeriods(periodsArr);
      setAccountsList(accts);
      setPlans(plansArr);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load plans');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onDeletePlan(plan: BudgetPlan) {
    if (!confirm(
      `Delete budget plan "${plan.name}"?\n\nAll periods, bills, and category allowances under this plan will be removed. Transactions are not affected.`,
    )) return;
    try {
      await api.deleteBudgetPlan(plan.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Plan delete failed');
    }
  }

  async function onDeletePeriod(planId: string, periodStart: string, label: string) {
    if (!confirm(
      `Delete this period (${label})?\n\nEvery budget row for this period in the plan will be removed. ` +
        `The plan itself and its other periods stay intact. ` +
        `Re-run the AutoMagic wizard with the same plan name to repopulate when new data is in.`,
    )) return;
    try {
      await api.deletePaycheckPeriod(planId, periodStart);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Period delete failed');
    }
  }

  // 0.21.x — paycheck budget only renders paycheck-cadence
  // periods. Monthly-cadence periods belong on /monthly-budget;
  // they used to leak in when a plan was misconfigured as
  // "monthly" in the wizard.
  const paycheckPeriods = periods.filter((p) => p.period.type !== 'monthly');

  // Group periods by plan_id (null = legacy / empty placeholder).
  const byPlan = new Map<string, BudgetPeriodSummary[]>();
  for (const p of paycheckPeriods) {
    const key = p.plan_id ?? '__none__';
    const arr = byPlan.get(key) ?? [];
    arr.push(p);
    byPlan.set(key, arr);
  }
  const planOrder: Array<{
    key: string;
    plan: BudgetPlan | null;
    list: BudgetPeriodSummary[];
  }> = [];
  for (const plan of plans) {
    const list = byPlan.get(plan.id);
    if (list && list.length > 0) {
      planOrder.push({ key: plan.id, plan, list });
    }
  }
  const noneList = byPlan.get('__none__');
  if (noneList && noneList.length > 0) {
    planOrder.push({ key: '__none__', plan: null, list: noneList });
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Paycheck Budget</h1>
          <div className="subtitle">
            One plan per paycheck cycle — income, bills, set-aside,
            net per period. For calendar-month category totals see{' '}
            <strong>Monthly budget</strong> in the sidebar.
          </div>
        </div>
        <div className="toolbar inline">
          <button
            className="btn"
            onClick={() => setShowWizard(true)}
            title="Generate multiple future periods at once with bills + groceries + fuel + tolls pre-filled"
          >
            ✨ AutoMagic setup
          </button>
        </div>
      </div>

      {wizardSummary && <div className="banner success">{wizardSummary}</div>}
      {error && <div className="banner error">{error}</div>}

      {showWizard && (
        <BudgetWizard
          onClose={() => setShowWizard(false)}
          onCommitted={(r) => {
            setShowWizard(false);
            setWizardSummary(
              `Plan created with ${r.created} budget row${r.created === 1 ? '' : 's'}` +
                (r.skipped > 0 ? `, skipped ${r.skipped} duplicate(s).` : '.'),
            );
            void load();
          }}
        />
      )}

      {loading && periods.length === 0 && <p className="empty">Loading…</p>}

      {!loading && planOrder.length === 0 && (
        <div className="card empty-card">
          <p className="muted">
            No paycheck plans yet. Run AutoMagic setup to generate
            future periods from your bills + recurring income.
          </p>
          <button
            className="btn"
            type="button"
            onClick={() => setShowWizard(true)}
          >
            ✨ Run AutoMagic Setup
          </button>
        </div>
      )}

      {planOrder.map(({ key, plan, list }) => (
        <PlanBlock
          key={key}
          plan={plan}
          periods={list}
          accounts={accountsList}
          onRunWizard={() => setShowWizard(true)}
          onDeletePlan={onDeletePlan}
          onDeletePeriod={onDeletePeriod}
        />
      ))}
    </div>
  );
}

function PlanBlock({
  plan,
  periods,
  accounts,
  onRunWizard,
  onDeletePlan,
  onDeletePeriod,
}: {
  plan: BudgetPlan | null;
  periods: BudgetPeriodSummary[];
  accounts: Account[];
  onRunWizard: () => void;
  onDeletePlan: (plan: BudgetPlan) => void;
  onDeletePeriod: (
    planId: string,
    periodStart: string,
    label: string,
  ) => Promise<void>;
}) {
  const planAccountNames = plan
    ? plan.account_ids.map(
        (id) => accounts.find((a) => a.id === id)?.name ?? '(removed)',
      )
    : null;
  const cadenceLabel = plan ? PERIOD_LABELS[plan.period_type] : null;
  return (
    <div style={{ marginBottom: 24 }}>
      {plan && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 12,
            margin: '12px 0 8px',
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>{plan.name}</h3>
            <div className="muted small" style={{ marginTop: 2 }}>
              {cadenceLabel} · anchor {formatDate(plan.anchor_date)}
              {planAccountNames && planAccountNames.length > 0 && (
                <>
                  {' · '}
                  Accounts: <strong>{planAccountNames.join(', ')}</strong>
                </>
              )}
              {planAccountNames && planAccountNames.length === 0 && (
                <> · All accounts</>
              )}
            </div>
          </div>
          <button
            type="button"
            className="btn-link danger"
            onClick={() => onDeletePlan(plan)}
            title="Remove this plan and its periods"
          >
            Delete plan
          </button>
        </div>
      )}
      {periods.length === 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          No periods committed for this plan yet — run AutoMagic setup
          to populate.
        </p>
      )}
      {periods.map((p) => (
        <PeriodBreakdown
          key={`${p.period.start}-${p.period.end}-${p.period.type}`}
          summary={p}
          onDeletePeriod={onDeletePeriod}
        />
      ))}
    </div>
  );
}

/**
 * 0.21.x — full-detail period card for the paycheck budget. Shows
 * income, bills, and set-aside categories for the period plus the
 * net at the bottom. Replaces the old "Period overview" card
 * (which mislabelled cadence) and the compact one-line summary
 * (which hid useful detail).
 */
function PeriodBreakdown({
  summary,
  onDeletePeriod,
}: {
  summary: BudgetPeriodSummary;
  onDeletePeriod: (
    planId: string,
    periodStart: string,
    label: string,
  ) => Promise<void>;
}) {
  const { period, income, bills, editable, totals } = summary;
  const net = totals.net_cents;
  const overextended = net < 0;
  const label = `${formatDate(period.start)} → ${formatDate(period.end)}`;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
        }}
      >
        <strong>{label}</strong>
        {summary.plan_id && (
          <button
            type="button"
            className="btn-link danger"
            onClick={() =>
              void onDeletePeriod(summary.plan_id!, period.start, label)
            }
            title="Remove every budget row for this period"
          >
            Delete period
          </button>
        )}
      </div>

      {/* Income */}
      <h3 style={{ marginTop: 14, marginBottom: 6 }}>
        Income — <strong className="pos">+{formatCents(totals.income_cents)}</strong>
      </h3>
      {income.length === 0 ? (
        <p className="muted small">No income events in this period.</p>
      ) : (
        <table className="txn-table">
          <thead>
            <tr>
              <th>Source</th>
              <th className="nowrap">Expected</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {income.map((i) => (
              <tr key={i.id + i.date}>
                <td>{i.name}</td>
                <td className="nowrap">{formatDate(i.date)}</td>
                <td className="num pos">+{formatCents(i.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Bills */}
      <h3 style={{ marginTop: 14, marginBottom: 6 }}>
        Bills — <strong className="neg">−{formatCents(totals.bills_cents)}</strong>
      </h3>
      {bills.length === 0 ? (
        <p className="muted small">No bills due in this period.</p>
      ) : (
        <table className="txn-table">
          <thead>
            <tr>
              <th>Vendor</th>
              <th className="nowrap">Due</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.budget_id}>
                <td>{b.name}</td>
                <td className="nowrap">
                  {b.date ? formatDate(b.date) : <span className="muted">—</span>}
                </td>
                <td className="num neg">−{formatCents(b.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Editable / set-aside categories */}
      <h3 style={{ marginTop: 14, marginBottom: 6 }}>
        Set aside —{' '}
        <strong className="neg">−{formatCents(totals.editable_cents)}</strong>
      </h3>
      {editable.length === 0 ? (
        <p className="muted small">No category allowances for this period.</p>
      ) : (
        <table className="txn-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Action</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {editable.map((e) => (
              <tr key={e.budget_id}>
                <td>{e.category_name}</td>
                <td className="muted small">
                  {e.requires_manual_action
                    ? 'Manually transfer to savings'
                    : 'Spending allowance'}
                </td>
                <td className="num neg">−{formatCents(e.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Net */}
      <div
        style={{
          marginTop: 16,
          paddingTop: 10,
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <span>
          <strong>{overextended ? 'Overextended by' : 'Leftover'}</strong>
          <div className="muted small">
            Income − bills − set-aside
          </div>
        </span>
        <strong
          className={overextended ? 'neg' : 'pos'}
          style={{ fontSize: '1.2em' }}
        >
          {overextended ? '−' : '+'}
          {formatCents(Math.abs(net))}
        </strong>
      </div>
    </div>
  );
}

// PeriodOverview removed in 0.21.x — replaced by the compact
// per-period summary table inside PlanBlock. The old card was
// labelled "Period overview" with "Monthly · …" subtext that
// didn't reflect the actual cadence of paycheck plans, and its
// income / bills / set-aside breakdown duplicated data already
// shown on bills and category pages without contributing
// information specific to this view.
