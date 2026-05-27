import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';
import { FEATURES, requireFeature } from '../auth/entitlements.js';
import { isUuid } from '../util.js';

/**
 * Phase 9.3 — calendar budget view.
 *
 * One read endpoint that powers the entire /calendar page: per-day
 * spend / income / txn-count + bills-due (with amounts), the month
 * summary, and the upcoming activity window (bills + recurring
 * income).
 *
 * 0.21.x updates:
 *   • Optional ?accountIds=uuid,uuid filter — restricts both the
 *     per-day aggregates and the budgets total to the selected
 *     accounts. Budgets with included_account_ids overlapping the
 *     filter are counted; budgets with no scoping are kept too
 *     (they apply to all accounts).
 *   • Optional ?upcomingDays=N — replaces the hardcoded 14-day
 *     upcoming window. 1..365.
 *   • Per-day output now includes bills_due_amount_cents and the
 *     full bill objects (not just IDs) so the client can expand a
 *     cell inline without a second fetch.
 *   • Upcoming list combines bills (expense) + recurring_income
 *     (income) so the client can render both with direction-aware
 *     colors.
 */

interface DayCell {
  date: string;
  spend_cents: number;
  income_cents: number;
  txn_count: number;
  bills_due: Array<{
    id: string;
    name: string;
    amount_cents: number;
  }>;
}

interface UpcomingItem {
  id: string;
  name: string;
  date: string;
  amount_cents: number;
  /** Positive amount; sign carried by `direction`. */
  direction: 'income' | 'expense';
  /** Optional cadence for display. */
  frequency: string | null;
}

interface CalendarMonthResponse {
  year: number;
  month: number;
  daysInMonth: number;
  monthStart: string;
  monthEnd: string;
  days: DayCell[];
  totals: {
    spend_cents: number;
    income_cents: number;
    budget_cents: number;
    today_position: number | null;
  };
  upcoming: UpcomingItem[];
  /** Echo of the upcoming window the server used, in days. */
  upcoming_days: number;
}

function requireTenant(req: FastifyRequest, reply: FastifyReply): string | null {
  if (!req.user) {
    reply.code(401).send({ error: 'Not authenticated' });
    return null;
  }
  if (!req.user.tenantId) {
    reply.code(403).send({ error: 'No active tenant' });
    return null;
  }
  return req.user.tenantId;
}

function parseAccountIds(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) if (!isUuid(id)) return null;
  return ids;
}

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { month: string };
    Querystring: { accountIds?: string; upcomingDays?: string };
  }>('/api/calendar/:month', async (req, reply): Promise<CalendarMonthResponse | undefined> => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const denyFeat = await requireFeature(tenantId, FEATURES.CALENDAR_VIEW);
    if (denyFeat) {
      reply.code(denyFeat.status).send({ error: denyFeat.error });
      return;
    }
    const m = req.params.month.match(/^(\d{4})-(\d{2})$/);
    if (!m) {
      reply.code(400).send({ error: 'month must be YYYY-MM' });
      return;
    }
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) {
      reply.code(400).send({ error: 'Invalid month' });
      return;
    }
    const monthStart = `${m[1]}-${m[2]}-01`;

    const accountIds = parseAccountIds(req.query.accountIds);
    if (req.query.accountIds && accountIds === null) {
      reply.code(400).send({ error: 'accountIds must be UUIDs' });
      return;
    }
    const upcomingDays = Math.min(
      Math.max(Number(req.query.upcomingDays) || 14, 1),
      365,
    );

    const meta = await pool.query<{ days_in_month: number; month_end: string }>(
      `SELECT EXTRACT(DAY FROM ((date_trunc('month', $1::date) + interval '1 month - 1 day')::date))::int
                AS days_in_month,
              ((date_trunc('month', $1::date) + interval '1 month - 1 day')::date)::text
                AS month_end`,
      [monthStart],
    );
    const { days_in_month: daysInMonth, month_end: monthEnd } = meta.rows[0]!;

    // Per-day transaction aggregates. Account filter applies if
    // accountIds were supplied. Transfers are excluded so internal
    // moves between own accounts don't double-count.
    const txns = await pool.query<{
      d: string;
      spend_cents: string;
      income_cents: string;
      txn_count: number;
    }>(
      `SELECT t.txn_date::text AS d,
              COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END), 0)::bigint
                AS spend_cents,
              COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END), 0)::bigint
                AS income_cents,
              COUNT(*)::int AS txn_count
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.tenant_id = $1
          AND t.txn_date BETWEEN $2::date AND $3::date
          AND t.transfer_group_id IS NULL
          AND ($4::uuid[] IS NULL OR t.account_id = ANY($4::uuid[]))
        GROUP BY t.txn_date`,
      [tenantId, monthStart, monthEnd, accountIds],
    );

    // Bills due this month, with amount + name so cells can expand
    // inline. Account filter: keep a bill if it's NOT scoped to any
    // account, OR if it's scoped to one of the selected accounts.
    const billsThisMonth = await pool.query<{
      id: string;
      name: string;
      d: string;
      amount_cents: string;
    }>(
      `SELECT id, name, next_due_date::text AS d, amount_cents::text
         FROM bills b
        WHERE b.tenant_id = $1
          AND b.active = true
          AND b.next_due_date BETWEEN $2::date AND $3::date
          AND ($4::uuid[] IS NULL
               OR b.account_id IS NULL
               OR b.account_id = ANY($4::uuid[]))`,
      [tenantId, monthStart, monthEnd, accountIds],
    );
    const billsByDay = new Map<string, Array<{ id: string; name: string; amount_cents: number }>>();
    for (const b of billsThisMonth.rows) {
      const arr = billsByDay.get(b.d) ?? [];
      arr.push({ id: b.id, name: b.name, amount_cents: Number(b.amount_cents) });
      billsByDay.set(b.d, arr);
    }

    const txnMap = new Map(
      txns.rows.map((r) => [
        r.d,
        {
          spend_cents: Number(r.spend_cents),
          income_cents: Number(r.income_cents),
          txn_count: r.txn_count,
        },
      ]),
    );
    const days: DayCell[] = Array.from({ length: daysInMonth }, (_, i) => {
      const dd = String(i + 1).padStart(2, '0');
      const date = `${m[1]}-${m[2]}-${dd}`;
      const txn = txnMap.get(date);
      return {
        date,
        spend_cents: txn?.spend_cents ?? 0,
        income_cents: txn?.income_cents ?? 0,
        txn_count: txn?.txn_count ?? 0,
        bills_due: billsByDay.get(date) ?? [],
      };
    });

    // Month budget total. When accounts are filtered, count budgets
    // that include at least one of those accounts (or no scope at all).
    const budget = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total
         FROM budgets
        WHERE tenant_id = $1
          AND period_month = date_trunc('month', $2::date)
          AND ($3::uuid[] IS NULL
               OR included_account_ids IS NULL
               OR array_length(included_account_ids, 1) IS NULL
               OR included_account_ids && $3::uuid[])`,
      [tenantId, monthStart, accountIds],
    );
    const spendTotal = days.reduce((a, d) => a + d.spend_cents, 0);
    const incomeTotal = days.reduce((a, d) => a + d.income_cents, 0);

    const now = new Date();
    const today_position =
      now.getUTCFullYear() === year && now.getUTCMonth() + 1 === month
        ? now.getUTCDate() / daysInMonth
        : null;

    // Upcoming bills + recurring income within the window.
    const upcomingBills = await pool.query<{
      id: string;
      name: string;
      next_due_date: string;
      amount_cents: string;
      frequency: string;
    }>(
      `SELECT id, name, next_due_date::text, amount_cents::text, frequency
         FROM bills b
        WHERE b.tenant_id = $1
          AND b.active = true
          AND b.next_due_date >= CURRENT_DATE
          AND b.next_due_date <  CURRENT_DATE + ($2::int || ' days')::interval
          AND ($3::uuid[] IS NULL
               OR b.account_id IS NULL
               OR b.account_id = ANY($3::uuid[]))
        ORDER BY b.next_due_date
        LIMIT 50`,
      [tenantId, upcomingDays, accountIds],
    );
    const upcomingIncome = await pool.query<{
      id: string;
      name: string;
      next_expected_date: string;
      amount_cents: string;
      frequency: string;
    }>(
      `SELECT id, name, next_expected_date::text, amount_cents::text, frequency
         FROM recurring_income ri
        WHERE ri.tenant_id = $1
          AND ri.active = true
          AND ri.next_expected_date >= CURRENT_DATE
          AND ri.next_expected_date <  CURRENT_DATE + ($2::int || ' days')::interval
          AND ($3::uuid[] IS NULL
               OR ri.account_id IS NULL
               OR ri.account_id = ANY($3::uuid[]))
        ORDER BY ri.next_expected_date
        LIMIT 50`,
      [tenantId, upcomingDays, accountIds],
    );
    const upcoming: UpcomingItem[] = [
      ...upcomingBills.rows.map<UpcomingItem>((b) => ({
        id: b.id,
        name: b.name,
        date: b.next_due_date,
        amount_cents: Number(b.amount_cents),
        direction: 'expense',
        frequency: b.frequency,
      })),
      ...upcomingIncome.rows.map<UpcomingItem>((i) => ({
        id: i.id,
        name: i.name,
        date: i.next_expected_date,
        amount_cents: Number(i.amount_cents),
        direction: 'income',
        frequency: i.frequency,
      })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    return {
      year,
      month,
      daysInMonth,
      monthStart,
      monthEnd,
      days,
      totals: {
        spend_cents: spendTotal,
        income_cents: incomeTotal,
        budget_cents: Number(budget.rows[0]!.total),
        today_position,
      },
      upcoming,
      upcoming_days: upcomingDays,
    };
  });
}
