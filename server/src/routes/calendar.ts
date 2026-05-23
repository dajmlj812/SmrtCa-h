import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';

/**
 * Phase 9.3 — calendar budget view.
 *
 * One read endpoint that powers the entire /calendar page: per-day
 * spend totals + transaction counts + bill-due markers for a single
 * month, plus the month summary (total spend, total budget, pace).
 *
 * Tenant-scoped. Pure read; no auth-gate beyond the session.
 */

interface CalendarMonthResponse {
  year: number;
  month: number; // 1..12
  daysInMonth: number;
  /** First day of the month as ISO YYYY-MM-DD. */
  monthStart: string;
  monthEnd: string;
  days: Array<{
    date: string; // YYYY-MM-DD
    spend_cents: number; // sum of NEGATIVE amounts (positive number, magnitude)
    income_cents: number; // sum of POSITIVE amounts
    txn_count: number;
    bill_due_ids: string[];
  }>;
  totals: {
    spend_cents: number;
    income_cents: number;
    budget_cents: number;
    /** Day-of-month / daysInMonth — useful for pace calc on the client. */
    today_position: number | null;
  };
  upcoming_bills: Array<{
    id: string;
    name: string;
    next_due_date: string;
    amount_cents: number;
    frequency: string;
  }>;
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

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { month: string } }>(
    '/api/calendar/:month',
    async (req, reply): Promise<CalendarMonthResponse | undefined> => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
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
      // The DB does the date math; pulling daysInMonth from Postgres
      // keeps us off the JS-Date-is-mutable footgun.
      const meta = await pool.query<{
        days_in_month: number;
        month_end: string;
      }>(
        `SELECT EXTRACT(DAY FROM ((date_trunc('month', $1::date) + interval '1 month - 1 day')::date))::int
                  AS days_in_month,
                ((date_trunc('month', $1::date) + interval '1 month - 1 day')::date)::text
                  AS month_end`,
        [monthStart],
      );
      const { days_in_month: daysInMonth, month_end: monthEnd } = meta.rows[0]!;

      // Per-day txn aggregates. Bill rows joined in below.
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
          GROUP BY t.txn_date`,
        [tenantId, monthStart, monthEnd],
      );

      const billsByDay = await pool.query<{ id: string; d: string }>(
        `SELECT id, next_due_date::text AS d
           FROM bills
          WHERE tenant_id = $1 AND active = true
            AND next_due_date BETWEEN $2::date AND $3::date`,
        [tenantId, monthStart, monthEnd],
      );
      const billsMap = new Map<string, string[]>();
      for (const b of billsByDay.rows) {
        const list = billsMap.get(b.d) ?? [];
        list.push(b.id);
        billsMap.set(b.d, list);
      }

      // Build the contiguous day list — even days with no txns appear
      // so the calendar grid can render an empty cell with bill markers.
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
      const days = Array.from({ length: daysInMonth }, (_, i) => {
        const dd = String(i + 1).padStart(2, '0');
        const date = `${m[1]}-${m[2]}-${dd}`;
        const txn = txnMap.get(date);
        return {
          date,
          spend_cents: txn?.spend_cents ?? 0,
          income_cents: txn?.income_cents ?? 0,
          txn_count: txn?.txn_count ?? 0,
          bill_due_ids: billsMap.get(date) ?? [],
        };
      });

      // Month totals + budget for the month.
      const budget = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total
           FROM budgets
          WHERE tenant_id = $1
            AND period_month = date_trunc('month', $2::date)`,
        [tenantId, monthStart],
      );
      const spendTotal = days.reduce((a, d) => a + d.spend_cents, 0);
      const incomeTotal = days.reduce((a, d) => a + d.income_cents, 0);

      // Today position within the month — null if we're not viewing
      // the current calendar month.
      const now = new Date();
      const today_position =
        now.getUTCFullYear() === year && now.getUTCMonth() + 1 === month
          ? now.getUTCDate() / daysInMonth
          : null;

      const upcoming = await pool.query<{
        id: string;
        name: string;
        next_due_date: string;
        amount_cents: string;
        frequency: string;
      }>(
        `SELECT id, name, next_due_date::text, amount_cents, frequency
           FROM bills
          WHERE tenant_id = $1 AND active = true
            AND next_due_date >= CURRENT_DATE
            AND next_due_date < CURRENT_DATE + INTERVAL '14 days'
          ORDER BY next_due_date
          LIMIT 20`,
        [tenantId],
      );

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
        upcoming_bills: upcoming.rows.map((b) => ({
          id: b.id,
          name: b.name,
          next_due_date: b.next_due_date,
          amount_cents: Number(b.amount_cents),
          frequency: b.frequency,
        })),
      };
    },
  );
}
