import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';
import {
  assertAccountInTenant,
  assertCategoryUsableByTenant,
  requireTenant,
} from '../auth/rbac.js';

type Frequency = 'monthly' | 'weekly' | 'biweekly' | 'yearly' | 'one-time';
const BILL_FREQUENCIES: Frequency[] = [
  'monthly',
  'weekly',
  'biweekly',
  'yearly',
  'one-time',
];
const INCOME_FREQUENCIES: Frequency[] = ['monthly', 'weekly', 'biweekly', 'yearly'];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Advance a date by one period of the given frequency. Returns null for one-time. */
export function advanceByFrequency(date: string, freq: Frequency): string | null {
  if (freq === 'one-time') return null;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  switch (freq) {
    case 'weekly':
      dt.setUTCDate(dt.getUTCDate() + 7);
      break;
    case 'biweekly':
      dt.setUTCDate(dt.getUTCDate() + 14);
      break;
    case 'monthly':
      dt.setUTCMonth(dt.getUTCMonth() + 1);
      break;
    case 'yearly':
      dt.setUTCFullYear(dt.getUTCFullYear() + 1);
      break;
  }
  return dt.toISOString().slice(0, 10);
}

const BILL_COLUMNS = `id, name, amount_cents, frequency, next_due_date,
  category_id, account_id, active, review_status, review_note,
  last_reviewed_at,
  cancel_url, cancel_email_template, cancel_steps, cancel_notes,
  negotiate_url, negotiate_email_template, negotiate_steps, negotiate_notes,
  created_at`;
const REVIEW_STATUSES = ['active', 'review', 'cancel', 'alter', 'keep'] as const;
type ReviewStatus = (typeof REVIEW_STATUSES)[number];
const INCOME_COLUMNS = `id, name, amount_cents, frequency, next_expected_date,
  account_id, active, created_at`;

/**
 * 0.14.1 — bills, recurring-income, and the cash-flow projection are
 * all per-tenant. POST writes `tenant_id` from the session;
 * `accountId` / `categoryId` (when supplied) are validated against the
 * caller's tenant before insertion. Cash-flow's net-worth seed and
 * bill/income walk all filter by `tenant_id` so two households can
 * have wildly different forecasts on the same instance without one
 * leaking into the other.
 */
export async function billRoutes(app: FastifyInstance): Promise<void> {
  // ── Bills ───────────────────────────────────────────────
  app.get<{ Querystring: { reviewStatus?: string } }>(
    '/api/bills',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const filter = (req.query.reviewStatus ?? '').trim();
      if (filter === '') {
        const r = await query(
          `SELECT ${BILL_COLUMNS} FROM bills
            WHERE tenant_id = $1
            ORDER BY active DESC, next_due_date`,
          [tenantId],
        );
        return { bills: r.rows };
      }
      if (filter === 'queue') {
        const r = await query(
          `SELECT ${BILL_COLUMNS} FROM bills
            WHERE tenant_id = $1
              AND review_status IN ('review','cancel','alter')
            ORDER BY last_reviewed_at DESC NULLS LAST, next_due_date`,
          [tenantId],
        );
        return { bills: r.rows };
      }
      if (!REVIEW_STATUSES.includes(filter as ReviewStatus)) {
        return reply.code(400).send({
          error: `reviewStatus must be one of: ${REVIEW_STATUSES.join(', ')}, queue`,
        });
      }
      const r = await query(
        `SELECT ${BILL_COLUMNS} FROM bills
          WHERE tenant_id = $1
            AND review_status = $2
          ORDER BY active DESC, next_due_date`,
        [tenantId, filter],
      );
      return { bills: r.rows };
    },
  );

  app.post('/api/bills', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asString(body.name);
    if (name === '') return reply.code(400).send({ error: 'Name is required' });
    const amount = asPositiveInt(body.amountCents);
    if (amount === null)
      return reply.code(400).send({ error: 'amountCents must be > 0' });
    const freq = body.frequency as Frequency;
    if (!BILL_FREQUENCIES.includes(freq))
      return reply.code(400).send({
        error: `frequency must be one of: ${BILL_FREQUENCIES.join(', ')}`,
      });
    if (typeof body.nextDueDate !== 'string' || !YMD.test(body.nextDueDate))
      return reply.code(400).send({ error: 'nextDueDate must be YYYY-MM-DD' });

    // Validate categoryId + accountId belong to this tenant when supplied.
    let categoryId: string | null = null;
    if (typeof body.categoryId === 'string' && isUuid(body.categoryId)) {
      const ok = await assertCategoryUsableByTenant(tenantId, body.categoryId);
      if (!ok) return reply.code(400).send({ error: 'Invalid categoryId' });
      categoryId = body.categoryId;
    }
    let accountId: string | null = null;
    if (typeof body.accountId === 'string' && isUuid(body.accountId)) {
      const ok = await assertAccountInTenant(tenantId, body.accountId);
      if (!ok) return reply.code(400).send({ error: 'Invalid accountId' });
      accountId = body.accountId;
    }

    const r = await query(
      `INSERT INTO bills (tenant_id, name, amount_cents, frequency, next_due_date,
                          category_id, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${BILL_COLUMNS}`,
      [tenantId, name, amount, freq, body.nextDueDate, categoryId, accountId],
    );
    return reply.code(201).send({ bill: r.rows[0] });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/bills/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid bill id' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updates: string[] = [];
      const params: unknown[] = [];

      if (body.name !== undefined) {
        const n = asString(body.name);
        if (n === '') return reply.code(400).send({ error: 'Empty name' });
        params.push(n);
        updates.push(`name = $${params.length}`);
      }
      if (body.amountCents !== undefined) {
        const a = asPositiveInt(body.amountCents);
        if (a === null)
          return reply.code(400).send({ error: 'amountCents must be > 0' });
        params.push(a);
        updates.push(`amount_cents = $${params.length}`);
      }
      if (body.frequency !== undefined) {
        if (!BILL_FREQUENCIES.includes(body.frequency as Frequency))
          return reply.code(400).send({ error: 'Invalid frequency' });
        params.push(body.frequency);
        updates.push(`frequency = $${params.length}`);
      }
      if (body.nextDueDate !== undefined) {
        if (typeof body.nextDueDate !== 'string' || !YMD.test(body.nextDueDate))
          return reply.code(400).send({ error: 'nextDueDate must be YYYY-MM-DD' });
        params.push(body.nextDueDate);
        updates.push(`next_due_date = $${params.length}`);
      }
      if (body.active !== undefined) {
        params.push(Boolean(body.active));
        updates.push(`active = $${params.length}`);
      }
      // 0.17.18 — let the user fix account_id on existing bills.
      // accountId === null clears it (bill becomes unscoped =
      // no longer shown on any plan card under strict semantics).
      if (body.accountId !== undefined) {
        if (body.accountId === null) {
          params.push(null);
          updates.push(`account_id = $${params.length}`);
        } else {
          if (typeof body.accountId !== 'string' || !isUuid(body.accountId)) {
            return reply.code(400).send({ error: 'Invalid accountId' });
          }
          const ok = await assertAccountInTenant(tenantId, body.accountId);
          if (!ok) return reply.code(400).send({ error: 'Invalid accountId' });
          params.push(body.accountId);
          updates.push(`account_id = $${params.length}`);
        }
      }
      // 0.18.1 — cancellation fields. All nullable text; explicit
      // null clears the value, undefined leaves it alone, a string
      // (after trim) is stored verbatim. No URL validation — users
      // sometimes paste an account-specific deep link we don't
      // want to over-constrain.
      for (const [key, col] of [
        ['cancelUrl', 'cancel_url'],
        ['cancelEmailTemplate', 'cancel_email_template'],
        ['cancelSteps', 'cancel_steps'],
        ['cancelNotes', 'cancel_notes'],
        // 0.19.1 — negotiation fields, same shape + handling.
        ['negotiateUrl', 'negotiate_url'],
        ['negotiateEmailTemplate', 'negotiate_email_template'],
        ['negotiateSteps', 'negotiate_steps'],
        ['negotiateNotes', 'negotiate_notes'],
      ] as const) {
        if (body[key] !== undefined) {
          const v = body[key];
          if (v === null) {
            params.push(null);
            updates.push(`${col} = $${params.length}`);
          } else if (typeof v === 'string') {
            const trimmed = v.trim();
            params.push(trimmed === '' ? null : trimmed);
            updates.push(`${col} = $${params.length}`);
          } else {
            return reply
              .code(400)
              .send({ error: `${key} must be a string or null` });
          }
        }
      }
      if (updates.length === 0)
        return reply.code(400).send({ error: 'No updates' });
      params.push(req.params.id);
      const idIdx = params.length;
      params.push(tenantId);
      const tenantIdx = params.length;
      const r = await query(
        `UPDATE bills SET ${updates.join(', ')}
          WHERE id = $${idIdx} AND tenant_id = $${tenantIdx}
       RETURNING ${BILL_COLUMNS}`,
        params,
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Bill not found' });
      return { bill: r.rows[0] };
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/bills/:id/review',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid bill id' });
      const body = (req.body ?? {}) as { status?: unknown; note?: unknown };
      if (
        typeof body.status !== 'string' ||
        !REVIEW_STATUSES.includes(body.status as ReviewStatus)
      ) {
        return reply.code(400).send({
          error: `status must be one of: ${REVIEW_STATUSES.join(', ')}`,
        });
      }
      const noteProvided = body.note !== undefined;
      const noteValue =
        body.note === null ? null : typeof body.note === 'string' ? body.note.trim() || null : null;
      const sql = noteProvided
        ? `UPDATE bills
              SET review_status = $1,
                  review_note = $2,
                  last_reviewed_at = now()
            WHERE id = $3 AND tenant_id = $4
        RETURNING ${BILL_COLUMNS}`
        : `UPDATE bills
              SET review_status = $1,
                  last_reviewed_at = now()
            WHERE id = $2 AND tenant_id = $3
        RETURNING ${BILL_COLUMNS}`;
      const params = noteProvided
        ? [body.status, noteValue, req.params.id, tenantId]
        : [body.status, req.params.id, tenantId];
      const r = await query(sql, params);
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Bill not found' });
      return { bill: r.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/bills/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid bill id' });
      const r = await query(
        'DELETE FROM bills WHERE id = $1 AND tenant_id = $2',
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Bill not found' });
      return reply.code(204).send();
    },
  );

  // 0.17.24 — clone a bill for the "multiple people sharing one
  // account but paying for separate subscriptions" case (two
  // Netflix accounts on the same Chase card, etc.). Copies every
  // field except id/review fields, names the new row "X (copy)"
  // so the user can spot + rename it.
  app.post<{ Params: { id: string } }>(
    '/api/bills/:id/duplicate',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid bill id' });
      const r = await query(
        `INSERT INTO bills
           (tenant_id, name, amount_cents, frequency, next_due_date,
            category_id, account_id, active)
         SELECT tenant_id,
                name || ' (copy)',
                amount_cents,
                frequency,
                next_due_date,
                category_id,
                account_id,
                active
           FROM bills
          WHERE id = $1 AND tenant_id = $2
       RETURNING ${BILL_COLUMNS}`,
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Bill not found' });
      return reply.code(201).send({ bill: r.rows[0] });
    },
  );

  // Advances next_due_date by one period. One-time bills are deactivated.
  app.post<{ Params: { id: string } }>(
    '/api/bills/:id/mark-paid',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid bill id' });
      const current = await query<{
        id: string;
        frequency: Frequency;
        next_due_date: string;
      }>(
        `SELECT id, frequency, next_due_date FROM bills
          WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (current.rowCount === 0)
        return reply.code(404).send({ error: 'Bill not found' });
      const row = current.rows[0]!;
      const next = advanceByFrequency(row.next_due_date, row.frequency);
      const updated = next
        ? await query(
            `UPDATE bills SET next_due_date = $1::date
              WHERE id = $2 AND tenant_id = $3
              RETURNING ${BILL_COLUMNS}`,
            [next, row.id, tenantId],
          )
        : await query(
            `UPDATE bills SET active = false
              WHERE id = $1 AND tenant_id = $2
              RETURNING ${BILL_COLUMNS}`,
            [row.id, tenantId],
          );
      return { bill: updated.rows[0] };
    },
  );

  // Upcoming N days of active bills.
  app.get<{ Querystring: { days?: string } }>(
    '/api/bills/upcoming',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const days = Math.min(
        Math.max(Number(req.query.days) || 30, 1),
        365,
      );
      const r = await query(
        `SELECT b.id, b.name, b.amount_cents, b.frequency, b.next_due_date,
                b.category_id, b.account_id, b.active, b.created_at,
                c.name AS category_name
           FROM bills b
      LEFT JOIN categories c ON c.id = b.category_id
          WHERE b.tenant_id = $1
            AND b.active
            AND b.next_due_date <= now()::date + make_interval(days => $2::int)
       ORDER BY b.next_due_date`,
        [tenantId, days],
      );
      return { days, bills: r.rows };
    },
  );

  // ── Recurring income ─────────────────────────────────────
  app.get('/api/recurring-income', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const r = await query(
      `SELECT ${INCOME_COLUMNS} FROM recurring_income
        WHERE tenant_id = $1
        ORDER BY active DESC, next_expected_date`,
      [tenantId],
    );
    return { income: r.rows };
  });

  app.post('/api/recurring-income', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asString(body.name);
    if (name === '') return reply.code(400).send({ error: 'Name is required' });
    const amount = asPositiveInt(body.amountCents);
    if (amount === null)
      return reply.code(400).send({ error: 'amountCents must be > 0' });
    const freq = body.frequency as Frequency;
    if (!INCOME_FREQUENCIES.includes(freq))
      return reply.code(400).send({
        error: `frequency must be one of: ${INCOME_FREQUENCIES.join(', ')}`,
      });
    if (
      typeof body.nextExpectedDate !== 'string' ||
      !YMD.test(body.nextExpectedDate)
    )
      return reply
        .code(400)
        .send({ error: 'nextExpectedDate must be YYYY-MM-DD' });

    let accountId: string | null = null;
    if (typeof body.accountId === 'string' && isUuid(body.accountId)) {
      const ok = await assertAccountInTenant(tenantId, body.accountId);
      if (!ok) return reply.code(400).send({ error: 'Invalid accountId' });
      accountId = body.accountId;
    }

    const r = await query(
      `INSERT INTO recurring_income
         (tenant_id, name, amount_cents, frequency, next_expected_date, account_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${INCOME_COLUMNS}`,
      [tenantId, name, amount, freq, body.nextExpectedDate, accountId],
    );
    return reply.code(201).send({ income: r.rows[0] });
  });

  app.delete<{ Params: { id: string } }>(
    '/api/recurring-income/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const r = await query(
        `DELETE FROM recurring_income WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Not found' });
      return reply.code(204).send();
    },
  );

  // 0.17.18 — recurring-income PATCH. Pre-fix there was no way
  // to edit an income source — the wizard / auto-detector
  // created it and that was it. Now editable, including
  // account_id so the user can fix mismatches the same way
  // bills support it.
  app.patch<{ Params: { id: string } }>(
    '/api/recurring-income/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updates: string[] = [];
      const params: unknown[] = [];

      if (body.name !== undefined) {
        const n = asString(body.name);
        if (n === '') return reply.code(400).send({ error: 'Empty name' });
        params.push(n);
        updates.push(`name = $${params.length}`);
      }
      if (body.amountCents !== undefined) {
        const a = asPositiveInt(body.amountCents);
        if (a === null)
          return reply.code(400).send({ error: 'amountCents must be > 0' });
        params.push(a);
        updates.push(`amount_cents = $${params.length}`);
      }
      if (body.frequency !== undefined) {
        if (!INCOME_FREQUENCIES.includes(body.frequency as Frequency))
          return reply.code(400).send({ error: 'Invalid frequency' });
        params.push(body.frequency);
        updates.push(`frequency = $${params.length}`);
      }
      if (body.nextExpectedDate !== undefined) {
        if (typeof body.nextExpectedDate !== 'string' || !YMD.test(body.nextExpectedDate))
          return reply.code(400).send({ error: 'nextExpectedDate must be YYYY-MM-DD' });
        params.push(body.nextExpectedDate);
        updates.push(`next_expected_date = $${params.length}`);
      }
      if (body.active !== undefined) {
        params.push(Boolean(body.active));
        updates.push(`active = $${params.length}`);
      }
      if (body.accountId !== undefined) {
        if (body.accountId === null) {
          params.push(null);
          updates.push(`account_id = $${params.length}`);
        } else {
          if (typeof body.accountId !== 'string' || !isUuid(body.accountId)) {
            return reply.code(400).send({ error: 'Invalid accountId' });
          }
          const ok = await assertAccountInTenant(tenantId, body.accountId);
          if (!ok) return reply.code(400).send({ error: 'Invalid accountId' });
          params.push(body.accountId);
          updates.push(`account_id = $${params.length}`);
        }
      }
      if (updates.length === 0)
        return reply.code(400).send({ error: 'No updates' });
      params.push(req.params.id);
      const idIdx = params.length;
      params.push(tenantId);
      const tenantIdx = params.length;
      const r = await query(
        `UPDATE recurring_income SET ${updates.join(', ')}
          WHERE id = $${idIdx} AND tenant_id = $${tenantIdx}
       RETURNING ${INCOME_COLUMNS}`,
        params,
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Income source not found' });
      return { income: r.rows[0] };
    },
  );

  // ── Cash-flow projection ─────────────────────────────────
  // Starts from the current net worth across THE CALLER'S accounts
  // and walks the next N days applying each bill / income event at
  // its expected date. Pre-0.14.1 this aggregated across every
  // tenant; now scoped end-to-end.
  app.get<{ Querystring: { days?: string } }>(
    '/api/cash-flow',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const days = Math.min(
        Math.max(Number(req.query.days) || 90, 1),
        365,
      );

      // 0.19.x — cash flow forecast starting balance.
      //
      // The starting point for a *cash* flow forecast must be CASH,
      // not net worth. A credit card with -$3000 in debt isn't $3000
      // of opportunity cost against your future spending; it's a
      // liability you'll pay from cash on a future bill cycle. Same
      // logic for loans / mortgages / manual_liability — including
      // them here would make "how much cash will I have in 60 days"
      // come out wrong.
      //
      // Include: checking, savings, cash, investment, manual_asset, other.
      // Exclude: credit_card, loan, manual_liability (these are
      //          liabilities; their balance represents debt, not
      //          spendable cash).
      const nw = await query<{ total: number }>(
        `SELECT COALESCE(SUM(
            a.opening_balance_cents +
            COALESCE(t.sum_amount, 0)
          ), 0)::bigint AS total
           FROM accounts a
      LEFT JOIN (
        SELECT t.account_id, SUM(t.amount_cents) AS sum_amount
          FROM transactions t
          JOIN accounts a ON a.id = t.account_id
         WHERE a.tenant_id = $1
           AND (a.opening_balance_date IS NULL
                OR t.txn_date >= a.opening_balance_date)
      GROUP BY t.account_id
      ) t ON t.account_id = a.id
          WHERE a.tenant_id = $1
            AND a.type NOT IN ('credit_card', 'loan', 'manual_liability')`,
        [tenantId],
      );
      let balance = Number(nw.rows[0]!.total);

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const horizon = new Date(today);
      horizon.setUTCDate(horizon.getUTCDate() + days);
      const horizonStr = horizon.toISOString().slice(0, 10);

      const events: Array<{ date: string; amount: number }> = [];

      const bills = await query<{
        amount_cents: number;
        frequency: Frequency;
        next_due_date: string;
      }>(
        `SELECT amount_cents, frequency, next_due_date
           FROM bills WHERE tenant_id = $1 AND active`,
        [tenantId],
      );
      for (const b of bills.rows) {
        let date: string | null = b.next_due_date;
        while (date !== null && date <= horizonStr) {
          if (date >= today.toISOString().slice(0, 10)) {
            events.push({ date, amount: -Number(b.amount_cents) });
          }
          date = advanceByFrequency(date, b.frequency);
        }
      }

      const incomes = await query<{
        amount_cents: number;
        frequency: Frequency;
        next_expected_date: string;
      }>(
        `SELECT amount_cents, frequency, next_expected_date
           FROM recurring_income WHERE tenant_id = $1 AND active`,
        [tenantId],
      );
      for (const i of incomes.rows) {
        let date: string | null = i.next_expected_date;
        while (date !== null && date <= horizonStr) {
          if (date >= today.toISOString().slice(0, 10)) {
            events.push({ date, amount: Number(i.amount_cents) });
          }
          date = advanceByFrequency(date, i.frequency);
        }
      }

      events.sort((a, b) => a.date.localeCompare(b.date));

      // 0.18.0 — confidence band derived from historical daily NET cash flow
      // (transactions excluding internal transfers). We model uncertainty as
      // a random walk: each day adds independent variance, so the band grows
      // as stddev * sqrt(t). Window is the last 90 days, which is enough to
      // smooth weekday/payday cycles without over-weighting old behavior.
      const HISTORY_DAYS = 90;
      const hist = await query<{ d: string; net: string }>(
        `SELECT to_char(t.txn_date, 'YYYY-MM-DD') AS d,
                SUM(t.amount_cents)::bigint AS net
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE a.tenant_id = $1
            AND t.transfer_group_id IS NULL
            AND t.txn_date >= (CURRENT_DATE - $2::int * INTERVAL '1 day')
            AND t.txn_date <  CURRENT_DATE
          GROUP BY t.txn_date
          ORDER BY t.txn_date`,
        [tenantId, HISTORY_DAYS],
      );
      const dayNets = new Map<string, number>();
      for (const r of hist.rows) dayNets.set(r.d, Number(r.net));
      // Fill in zero-spend days so stddev reflects true daily variability.
      const sampleStart = new Date(today);
      sampleStart.setUTCDate(sampleStart.getUTCDate() - HISTORY_DAYS);
      const samples: number[] = [];
      const sCursor = new Date(sampleStart);
      while (sCursor < today) {
        const ds = sCursor.toISOString().slice(0, 10);
        samples.push(dayNets.get(ds) ?? 0);
        sCursor.setUTCDate(sCursor.getUTCDate() + 1);
      }
      let dailyStdDev = 0;
      if (samples.length > 1) {
        const mean =
          samples.reduce((a, b) => a + b, 0) / samples.length;
        const variance =
          samples.reduce((a, b) => a + (b - mean) ** 2, 0) /
          (samples.length - 1);
        dailyStdDev = Math.sqrt(variance);
      }

      const series: Array<{
        date: string;
        projected_cents: number;
        low_cents: number;
        high_cents: number;
      }> = [];
      let eventIdx = 0;
      const cursor = new Date(today);
      let dayOffset = 0;
      while (cursor <= horizon) {
        const ds = cursor.toISOString().slice(0, 10);
        while (eventIdx < events.length && events[eventIdx]!.date === ds) {
          balance += events[eventIdx]!.amount;
          eventIdx++;
        }
        // Day 0 (today) has no band — we know the starting balance.
        const bandHalf = Math.round(dailyStdDev * Math.sqrt(dayOffset));
        series.push({
          date: ds,
          projected_cents: balance,
          low_cents: balance - bandHalf,
          high_cents: balance + bandHalf,
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        dayOffset++;
      }

      const milestoneAt = (n: number) => {
        // series[0] is today, so day N is series[N] when present.
        const idx = Math.min(n, series.length - 1);
        return idx >= 0 ? series[idx]!.projected_cents : balance;
      };

      // 0.21.5 — Scenario overlay.
      //
      // If the caller passes any of these query params, we re-walk
      // the timeline producing a second "scenario" series alongside
      // the baseline:
      //   incomePct=110   — multiply recurring income by 1.10
      //   expensePct=90   — multiply bill amounts by 0.90
      //   oneTime=2026-06-15:50000,2026-07-01:-12000
      //                   — comma-separated date:cents pairs (positive = income)
      const incomePct = Number(
        (req.query as Record<string, string | undefined>).incomePct ?? '100',
      );
      const expensePct = Number(
        (req.query as Record<string, string | undefined>).expensePct ?? '100',
      );
      const oneTimeRaw =
        (req.query as Record<string, string | undefined>).oneTime ?? '';
      const oneTime: Array<{ date: string; amount: number }> = [];
      if (oneTimeRaw) {
        for (const piece of oneTimeRaw.split(',')) {
          const [d, c] = piece.split(':');
          if (!d || !c || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
          const cents = Number(c);
          if (Number.isFinite(cents)) oneTime.push({ date: d, amount: cents });
        }
      }
      const hasScenario =
        incomePct !== 100 || expensePct !== 100 || oneTime.length > 0;

      let scenarioSeries: typeof series | null = null;
      if (hasScenario) {
        const scenarioEvents = events.map((e) => ({
          date: e.date,
          amount:
            e.amount >= 0
              ? Math.round(e.amount * (incomePct / 100))
              : Math.round(e.amount * (expensePct / 100)),
        }));
        for (const o of oneTime) scenarioEvents.push(o);
        scenarioEvents.sort((a, b) => a.date.localeCompare(b.date));
        let sBalance = Number(nw.rows[0]!.total);
        let sIdx = 0;
        const sCursor2 = new Date(today);
        scenarioSeries = [];
        let sDay = 0;
        while (sCursor2 <= horizon) {
          const ds = sCursor2.toISOString().slice(0, 10);
          while (sIdx < scenarioEvents.length && scenarioEvents[sIdx]!.date === ds) {
            sBalance += scenarioEvents[sIdx]!.amount;
            sIdx++;
          }
          const bh = Math.round(dailyStdDev * Math.sqrt(sDay));
          scenarioSeries.push({
            date: ds,
            projected_cents: sBalance,
            low_cents: sBalance - bh,
            high_cents: sBalance + bh,
          });
          sCursor2.setUTCDate(sCursor2.getUTCDate() + 1);
          sDay++;
        }
      }

      return {
        days,
        starting_cents: Number(nw.rows[0]!.total),
        ending_cents: balance,
        daily_volatility_cents: Math.round(dailyStdDev),
        milestones: {
          day_30: milestoneAt(30),
          day_60: milestoneAt(60),
          day_90: milestoneAt(90),
        },
        series,
        scenario: scenarioSeries
          ? {
              applied: {
                income_pct: incomePct,
                expense_pct: expensePct,
                one_time: oneTime,
              },
              ending_cents:
                scenarioSeries[scenarioSeries.length - 1]?.projected_cents ??
                Number(nw.rows[0]!.total),
              series: scenarioSeries,
            }
          : null,
      };
    },
  );
}
