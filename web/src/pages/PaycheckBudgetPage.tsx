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

  // Group periods by plan_id (null = legacy / empty placeholder).
  const byPlan = new Map<string, BudgetPeriodSummary[]>();
  for (const p of periods) {
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
      {/* 0.21.x — replaced the verbose PeriodOverview card with a
          compact summary line per period. The old card showed
          "Monthly" labels + income/bills/set-aside data that
          didn't match a paycheck plan's reality. The new line
          just shows the period window, total income / bills /
          set-aside, and a delete-period link. */}
      {periods.length > 0 && (
        <div className="card" style={{ padding: 8 }}>
          <table className="txn-table" style={{ marginBottom: 0 }}>
            <thead>
              <tr>
                <th>Window</th>
                <th className="num">Income</th>
                <th className="num">Bills</th>
                <th className="num">Set-aside</th>
                <th className="num">Net</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => {
                const net = p.totals.net_cents;
                const label = `${formatDate(p.period.start)} → ${formatDate(p.period.end)}`;
                return (
                  <tr
                    key={`${p.period.start}-${p.period.end}-${p.period.type}`}
                  >
                    <td className="nowrap">{label}</td>
                    <td className="num pos">
                      +{formatCents(p.totals.income_cents)}
                    </td>
                    <td className="num neg">
                      −{formatCents(p.totals.bills_cents)}
                    </td>
                    <td className="num neg">
                      −{formatCents(p.totals.editable_cents)}
                    </td>
                    <td className={`num ${net < 0 ? 'neg' : 'pos'}`}>
                      {net < 0 ? '−' : '+'}
                      {formatCents(Math.abs(net))}
                    </td>
                    <td>
                      {p.plan_id && (
                        <button
                          type="button"
                          className="btn-link danger"
                          onClick={() =>
                            void onDeletePeriod(
                              p.plan_id!,
                              p.period.start,
                              label,
                            )
                          }
                          title="Remove every budget row for this period"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {periods.length === 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          No periods committed for this plan yet — run AutoMagic setup
          to populate.
        </p>
      )}
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
