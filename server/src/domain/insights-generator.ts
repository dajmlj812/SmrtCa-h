import { query } from '../db/pool.js';

/**
 * 0.20.0 — proactive insight-card generator.
 *
 * Runs once per day per tenant (or on demand). For each signal
 * category, finds the few highest-value items and proposes cards.
 * Caller (insights-scheduler) then writes the proposed cards into
 * insight_cards, deduping against any still-open card with the
 * same (tenant_id, kind, source_id).
 *
 * Why a generator rather than ad-hoc inserts at each signal source:
 *   • Keeps the "what cards exist" logic in one place — easy to
 *     extend with new signal kinds.
 *   • Lets us cap card volume per tenant (we surface at most ~5
 *     active cards; more than that defeats the "notice" framing).
 *   • Side-effect-free for testing — returns proposed cards as a
 *     plain array. The scheduler decides what to persist.
 */

export type InsightKind =
  | 'anomaly'
  | 'budget_overrun_trend'
  | 'goal_pace_slipping'
  | 'unusual_recurring_charge'
  | 'cash_flow_warning'
  | 'fee_drag'
  | 'warranty_expiring';

export type InsightSeverity = 'info' | 'warn' | 'critical';

export interface ProposedInsight {
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  body: string;
  action_label?: string;
  action_url?: string;
  /** Polymorphic backref so dedupe can collapse repeat-day scans. */
  source_kind?: string;
  source_id?: string;
}

/**
 * Scan every signal source for a tenant; return all proposed cards.
 * Caller filters by dedupe + persists.
 */
export async function generateInsights(
  tenantId: string,
): Promise<ProposedInsight[]> {
  const proposed: ProposedInsight[] = [];

  // ── 1. Anomalies ─────────────────────────────────────────
  // The anomaly_detector already populates anomaly_alerts with
  // large_amount / unusual_at_merchant / duplicate_suspect rows.
  // Surface the most-recent un-dismissed high/warn ones as cards.
  // We cap at the 3 most-recent so a flood of anomalies doesn't
  // drown out other signals.
  const anomalies = await query<{
    id: string;
    transaction_id: string;
    kind: string;
    severity: string;
    message: string;
    detected_at: string;
  }>(
    `SELECT id, transaction_id, kind, severity, message, detected_at
       FROM anomaly_alerts
      WHERE tenant_id = $1
        AND dismissed = false
        AND severity IN ('warn', 'high')
        AND detected_at > now() - interval '14 days'
      ORDER BY detected_at DESC
      LIMIT 3`,
    [tenantId],
  );
  for (const a of anomalies.rows) {
    proposed.push({
      kind: 'anomaly',
      severity: a.severity === 'high' ? 'critical' : 'warn',
      title:
        a.kind === 'large_amount'
          ? 'Large transaction detected'
          : a.kind === 'unusual_at_merchant'
          ? 'Unusual charge at a merchant'
          : 'Possible duplicate charge',
      body: a.message,
      action_label: 'Review transaction',
      action_url: `/transactions?focus=${a.transaction_id}`,
      source_kind: 'anomaly_alert',
      source_id: a.id,
    });
  }

  // ── 2. Budget overrun trend ──────────────────────────────
  // For each active monthly budget, compare actual-so-far × end-of-
  // month projection against the budgeted amount. If projected
  // spend is >115% of budget AND we're past day 10, flag it.
  const budgetTrends = await query<{
    budget_id: string;
    category_id: string;
    category_name: string;
    amount_cents: string;
    spent_cents: string;
    days_in_month: number;
    days_elapsed: number;
  }>(
    `WITH this_month AS (
       SELECT date_trunc('month', now())::date AS m_start,
              (date_trunc('month', now()) + interval '1 month' - interval '1 day')::date AS m_end,
              EXTRACT(day FROM (date_trunc('month', now()) + interval '1 month' - interval '1 day'))::int AS days_in_month,
              EXTRACT(day FROM now())::int AS days_elapsed
     )
     SELECT b.id AS budget_id,
            b.category_id,
            COALESCE(c.name, 'Uncategorized') AS category_name,
            b.amount_cents::text,
            COALESCE(SUM(-t.amount_cents) FILTER (
              WHERE t.amount_cents < 0
                AND t.txn_date >= tm.m_start AND t.txn_date <= tm.m_end
            ), 0)::text AS spent_cents,
            tm.days_in_month,
            tm.days_elapsed
       FROM budgets b
       JOIN this_month tm ON true
       LEFT JOIN categories c ON c.id = b.category_id
       LEFT JOIN transactions t ON t.category_id = b.category_id
       JOIN accounts a ON a.id = t.account_id AND a.tenant_id = $1
      WHERE b.tenant_id = $1
        AND b.period_month = tm.m_start
        AND b.period_type = 'monthly'
      GROUP BY b.id, b.category_id, c.name, b.amount_cents, tm.days_in_month, tm.days_elapsed
      HAVING tm.days_elapsed >= 10`,
    [tenantId],
  );
  for (const r of budgetTrends.rows) {
    const budget = Number(r.amount_cents);
    const spent = Number(r.spent_cents);
    if (budget <= 0 || r.days_elapsed === 0) continue;
    const projected = spent * (r.days_in_month / r.days_elapsed);
    const projectedPct = (projected / budget) * 100;
    if (projectedPct < 115) continue;
    proposed.push({
      kind: 'budget_overrun_trend',
      severity: projectedPct > 150 ? 'critical' : 'warn',
      title: `${r.category_name} is trending over budget`,
      body: `At day ${r.days_elapsed}/${r.days_in_month}, you've spent ${formatCents(
        spent,
      )} of the ${formatCents(budget)} budget. At this pace, the month ends near ${formatCents(
        projected,
      )} (${projectedPct.toFixed(0)}% of budget).`,
      action_label: 'Open budget',
      action_url: `/budgets`,
      source_kind: 'budget',
      source_id: r.budget_id,
    });
  }

  // ── 3. Goal pace slipping ────────────────────────────────
  // For each goal with a target_date, check whether the user's
  // current pace meets the goal by the deadline. Flag goals where
  // current contribution velocity would miss the target by more
  // than 15%.
  const goalPace = await query<{
    id: string;
    name: string;
    target_amount_cents: string;
    current_amount_cents: string;
    target_date: string;
    days_to_target: number;
  }>(
    `SELECT id, name,
            target_amount_cents::text,
            current_amount_cents::text,
            target_date::text,
            (target_date - CURRENT_DATE)::int AS days_to_target
       FROM savings_goals
      WHERE tenant_id = $1
        AND target_date IS NOT NULL
        AND target_date > CURRENT_DATE
        AND current_amount_cents < target_amount_cents`,
    [tenantId],
  );
  for (const g of goalPace.rows) {
    const target = Number(g.target_amount_cents);
    const current = Number(g.current_amount_cents);
    const remaining = target - current;
    if (remaining <= 0 || g.days_to_target <= 0) continue;
    // Look at 90-day contribution velocity to extrapolate.
    const recent = await query<{ contributed: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS contributed
         FROM goal_contributions
        WHERE goal_id = $1
          AND occurred_at >= CURRENT_DATE - interval '90 days'`,
      [g.id],
    );
    const ninetyDayPace = Number(recent.rows[0]?.contributed ?? '0');
    const dailyPace = ninetyDayPace / 90;
    const projected = current + dailyPace * g.days_to_target;
    const missPct = ((target - projected) / target) * 100;
    if (missPct < 15) continue;
    proposed.push({
      kind: 'goal_pace_slipping',
      severity: missPct > 40 ? 'critical' : 'warn',
      title: `${g.name} is off pace`,
      body: `You need ${formatCents(remaining)} more in ${g.days_to_target} days. At the last 90 days' contribution rate, you'd land ${missPct.toFixed(0)}% short of the target.`,
      action_label: 'Open goal',
      action_url: `/goals`,
      source_kind: 'savings_goal',
      source_id: g.id,
    });
  }

  // ── 4. Fee drag (investments) ────────────────────────────
  // If any holding has an expense_ratio set and contributes more
  // than $200/yr of annual fees, surface it once. Capped at one
  // card to avoid drowning the dashboard.
  const feeDrag = await query<{
    holding_id: string;
    name: string;
    annual_fee_cents: string;
  }>(
    `SELECT h.id AS holding_id, h.name,
            ROUND((h.quantity * h.last_price_cents * h.expense_ratio) / 100)::bigint::text AS annual_fee_cents
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
      WHERE a.tenant_id = $1
        AND h.expense_ratio IS NOT NULL
        AND h.expense_ratio > 0
      ORDER BY (h.quantity * h.last_price_cents * h.expense_ratio) DESC
      LIMIT 1`,
    [tenantId],
  );
  if (feeDrag.rowCount && feeDrag.rowCount > 0) {
    const top = feeDrag.rows[0]!;
    const annualFee = Number(top.annual_fee_cents);
    if (annualFee > 20000) {
      proposed.push({
        kind: 'fee_drag',
        severity: 'info',
        title: 'Your highest-fee holding',
        body: `${top.name} is costing about ${formatCents(annualFee)} per year in expense ratio. Over 30 years at 7%, that compounds to roughly ${formatCents(annualFee * 94)} of foregone growth.`,
        action_label: 'See fee analysis',
        action_url: `/investments`,
        source_kind: 'holding',
        source_id: top.holding_id,
      });
    }
  }

  // ── 7. Warranty expiring (0.21.2) ────────────────────────
  // Anything covered for ≤ 30 more days gets one card per item.
  // Severity escalates as the date approaches.
  const warranties = await query<{
    id: string;
    item: string;
    vendor: string | null;
    warranty_until: string;
    days_remaining: string;
  }>(
    `SELECT id, item, vendor,
            warranty_until::text AS warranty_until,
            (warranty_until - CURRENT_DATE)::int::text AS days_remaining
       FROM warranties
      WHERE tenant_id = $1
        AND warranty_until >= CURRENT_DATE
        AND warranty_until <= CURRENT_DATE + INTERVAL '30 days'
      ORDER BY warranty_until ASC
      LIMIT 5`,
    [tenantId],
  );
  for (const w of warranties.rows) {
    const days = Number(w.days_remaining);
    const sev: InsightSeverity = days <= 3 ? 'critical' : days <= 14 ? 'warn' : 'info';
    proposed.push({
      kind: 'warranty_expiring',
      severity: sev,
      title: `Warranty ending soon: ${w.item}`,
      body:
        `Your ${w.item}${w.vendor ? ` (${w.vendor})` : ''} warranty expires ` +
        `on ${w.warranty_until} (${days} day${days === 1 ? '' : 's'} from today). ` +
        `If it has issues, file the claim before coverage lapses.`,
      action_label: 'Open warranty',
      action_url: `/warranties`,
      source_kind: 'warranty',
      source_id: w.id,
    });
  }

  return proposed;
}

function formatCents(c: number): string {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}
