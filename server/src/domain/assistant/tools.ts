import { pool } from '../../db/pool.js';
import { recordAudit } from '../audit.js';

/**
 * Phase 9.1 — AI assistant tool registry.
 *
 * Every tool defines:
 *   - `name`        — what the model calls it as
 *   - `description` — single-paragraph explanation handed to the model
 *   - `inputSchema` — JSON Schema for arguments (Anthropic tool-use shape)
 *   - `kind`        — 'read' or 'write'. Write tools call recordAudit()
 *                     before returning, so every mutation is traceable
 *                     from the super-admin audit log
 *   - `execute()`   — async; receives the resolved tenant + user IDs
 *                     plus the model-supplied input. Throws on bad
 *                     input or DB constraint violations.
 *
 * Tenant scoping is enforced by EVERY query. The assistant runtime
 * never trusts the model to pass a tenant_id; it's pulled from the
 * authenticated session.
 *
 * Bulk operations are hard-capped (BULK_LIMIT) so a confused model
 * can't recategorize the entire transaction history in one shot.
 */

const BULK_LIMIT = 500;

export interface AssistantToolContext {
  tenantId: string;
  userId: string;
}

export interface AssistantTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: 'read' | 'write';
  execute(ctx: AssistantToolContext, input: unknown): Promise<unknown>;
}

// ── Read tools ──────────────────────────────────────────────

interface QueryTransactionsInput {
  startDate?: string;
  endDate?: string;
  accountName?: string;
  category?: string;
  descriptionContains?: string;
  minAmountCents?: number;
  maxAmountCents?: number;
  limit?: number;
}

const queryTransactions: AssistantTool = {
  name: 'query_transactions',
  description:
    'List transactions matching the given filters. Returns up to 200 rows. Use this for any question about specific spending, merchants, or dates.',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'ISO date YYYY-MM-DD (inclusive)' },
      endDate: { type: 'string', description: 'ISO date YYYY-MM-DD (inclusive)' },
      accountName: { type: 'string', description: 'Exact account name' },
      category: { type: 'string', description: 'Exact category name' },
      descriptionContains: { type: 'string', description: 'Substring (case-insensitive)' },
      minAmountCents: { type: 'integer', description: 'Lower bound. Negative for spending.' },
      maxAmountCents: { type: 'integer', description: 'Upper bound.' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
  },
  async execute(ctx, input) {
    const i = input as QueryTransactionsInput;
    const where: string[] = ['a.tenant_id = $1'];
    const params: unknown[] = [ctx.tenantId];
    if (i.startDate) {
      params.push(i.startDate);
      where.push(`t.txn_date >= $${params.length}`);
    }
    if (i.endDate) {
      params.push(i.endDate);
      where.push(`t.txn_date <= $${params.length}`);
    }
    if (i.accountName) {
      params.push(i.accountName);
      where.push(`a.name = $${params.length}`);
    }
    if (i.category) {
      params.push(i.category);
      where.push(`c.name = $${params.length}`);
    }
    if (i.descriptionContains) {
      params.push(`%${i.descriptionContains}%`);
      where.push(`t.raw_description ILIKE $${params.length}`);
    }
    if (typeof i.minAmountCents === 'number') {
      params.push(i.minAmountCents);
      where.push(`t.amount_cents >= $${params.length}`);
    }
    if (typeof i.maxAmountCents === 'number') {
      params.push(i.maxAmountCents);
      where.push(`t.amount_cents <= $${params.length}`);
    }
    const limit = Math.min(Math.max(i.limit ?? 50, 1), 200);
    params.push(limit);
    const r = await pool.query(
      `SELECT t.id, t.txn_date::text AS date, t.amount_cents, t.raw_description,
              a.name AS account, c.name AS category
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.txn_date DESC, t.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return { transactions: r.rows, count: r.rowCount };
  },
};

const accountBalances: AssistantTool = {
  name: 'account_balances',
  description:
    'Return current balance for every account in the tenant. Use this for net-worth or "where is my money" questions.',
  kind: 'read',
  inputSchema: { type: 'object', properties: {} },
  async execute(ctx) {
    const r = await pool.query(
      `SELECT a.id, a.name, a.type, a.currency,
              a.opening_balance_cents
              + COALESCE((SELECT SUM(amount_cents) FROM transactions t
                           WHERE t.account_id = a.id
                             AND (a.opening_balance_date IS NULL
                                  OR t.txn_date >= a.opening_balance_date)), 0)
              AS balance_cents
         FROM accounts a
        WHERE a.tenant_id = $1
        ORDER BY a.name`,
      [ctx.tenantId],
    );
    return { accounts: r.rows };
  },
};

const listCategories: AssistantTool = {
  name: 'list_categories',
  description:
    'Return every category. The category name is the natural key used by other tools.',
  kind: 'read',
  inputSchema: { type: 'object', properties: {} },
  async execute(ctx) {
    const r = await pool.query(
      `SELECT c.id, c.name,
              p.name AS parent_name
         FROM categories c
         LEFT JOIN categories p ON p.id = c.parent_id
        WHERE c.tenant_id = $1 OR c.tenant_id IS NULL
        ORDER BY c.name`,
      [ctx.tenantId],
    );
    return { categories: r.rows };
  },
};

const spendingByCategory: AssistantTool = {
  name: 'spending_by_category',
  description:
    'Total spend per category in a date range. Returns negative amounts (spending) only by default; pass includeIncome=true to also see positive flows.',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      endDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      includeIncome: { type: 'boolean' },
    },
    required: ['startDate', 'endDate'],
  },
  async execute(ctx, input) {
    const i = input as { startDate: string; endDate: string; includeIncome?: boolean };
    const r = await pool.query(
      `SELECT COALESCE(c.name, '(uncategorized)') AS category,
              SUM(t.amount_cents)::bigint AS total_cents,
              COUNT(*)::int AS txn_count
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE a.tenant_id = $1
          AND t.txn_date BETWEEN $2 AND $3
          ${i.includeIncome ? '' : 'AND t.amount_cents < 0'}
        GROUP BY c.name
        ORDER BY total_cents ASC`,
      [ctx.tenantId, i.startDate, i.endDate],
    );
    return { byCategory: r.rows };
  },
};

const listBudgets: AssistantTool = {
  name: 'list_budgets',
  description:
    'Return budget rows. Each row is a (period_month, category) pair with a positive monthly amount_cents. When monthOf is omitted, returns all rows for the current month.',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      monthOf: {
        type: 'string',
        description: 'First-of-month ISO date (e.g. 2026-05-01); defaults to the current month',
      },
    },
  },
  async execute(ctx, input) {
    const i = input as { monthOf?: string };
    const params: unknown[] = [ctx.tenantId];
    let monthFilter = `AND b.period_month = date_trunc('month', CURRENT_DATE)`;
    if (i.monthOf) {
      params.push(i.monthOf);
      monthFilter = `AND b.period_month = $${params.length}`;
    }
    const r = await pool.query(
      `SELECT b.id, COALESCE(c.name, '(flex-pool)') AS category,
              b.amount_cents, b.period_month::text AS period_month
         FROM budgets b
         LEFT JOIN categories c ON c.id = b.category_id
        WHERE b.tenant_id = $1 ${monthFilter}
        ORDER BY c.name NULLS LAST`,
      params,
    );
    return { budgets: r.rows };
  },
};

const listBills: AssistantTool = {
  name: 'list_bills',
  description:
    'Return bill reminders and their next-due dates.',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: { onlyUpcoming: { type: 'boolean' } },
  },
  async execute(ctx, input) {
    const i = input as { onlyUpcoming?: boolean };
    const r = await pool.query(
      `SELECT id, name, amount_cents, next_due_date::text AS next_due, frequency
         FROM bills
        WHERE tenant_id = $1 AND active = true
          ${i.onlyUpcoming ? `AND next_due_date >= CURRENT_DATE` : ''}
        ORDER BY next_due_date`,
      [ctx.tenantId],
    );
    return { bills: r.rows };
  },
};

const listGoals: AssistantTool = {
  name: 'list_savings_goals',
  description: 'Return all savings goals (target amount, current amount, optional deadline).',
  kind: 'read',
  inputSchema: { type: 'object', properties: {} },
  async execute(ctx) {
    const r = await pool.query(
      `SELECT id, name, target_amount_cents, current_amount_cents, target_date::text AS target_date
         FROM savings_goals
        WHERE tenant_id = $1
        ORDER BY name`,
      [ctx.tenantId],
    );
    return { goals: r.rows };
  },
};

// ── Write tools (each one calls recordAudit) ────────────────

const updateTransactionCategory: AssistantTool = {
  name: 'update_transaction_category',
  description:
    'Set the category of a single transaction. Use the category NAME (not an id). The transaction must belong to the active tenant.',
  kind: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      transactionId: { type: 'string', description: 'UUID' },
      categoryName: { type: 'string' },
    },
    required: ['transactionId', 'categoryName'],
  },
  async execute(ctx, input) {
    const i = input as { transactionId: string; categoryName: string };
    const r = await pool.query(
      `UPDATE transactions t
          SET category_id = (
                SELECT id FROM categories
                 WHERE name = $2
                   AND (tenant_id = $3 OR tenant_id IS NULL)
                 LIMIT 1
              )
        FROM accounts a
        WHERE t.account_id = a.id
          AND a.tenant_id = $3
          AND t.id = $1
        RETURNING t.id`,
      [i.transactionId, i.categoryName, ctx.tenantId],
    );
    if (r.rowCount === 0) {
      throw new Error(`Transaction ${i.transactionId} not found in this tenant`);
    }
    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorKind: 'tenant_user',
      action: 'assistant.update_transaction_category',
      targetKind: 'transaction',
      targetId: i.transactionId,
      details: { categoryName: i.categoryName },
    });
    return { updated: r.rowCount };
  },
};

const bulkRecategorize: AssistantTool = {
  name: 'bulk_recategorize',
  description: `Recategorize many transactions in one shot. Matches by descriptionContains (ILIKE) AND optional date range, then sets category to categoryName. Hard cap: ${BULK_LIMIT} transactions per call.`,
  kind: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      descriptionContains: { type: 'string' },
      categoryName: { type: 'string' },
      startDate: { type: 'string' },
      endDate: { type: 'string' },
    },
    required: ['descriptionContains', 'categoryName'],
  },
  async execute(ctx, input) {
    const i = input as {
      descriptionContains: string;
      categoryName: string;
      startDate?: string;
      endDate?: string;
    };
    const params: unknown[] = [ctx.tenantId, `%${i.descriptionContains}%`, i.categoryName];
    let dateFilter = '';
    if (i.startDate) {
      params.push(i.startDate);
      dateFilter += ` AND t.txn_date >= $${params.length}`;
    }
    if (i.endDate) {
      params.push(i.endDate);
      dateFilter += ` AND t.txn_date <= $${params.length}`;
    }
    params.push(BULK_LIMIT);
    const r = await pool.query(
      `WITH targets AS (
         SELECT t.id FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE a.tenant_id = $1
            AND t.raw_description ILIKE $2 ${dateFilter}
          LIMIT $${params.length}
       )
       UPDATE transactions t
          SET category_id = (
                SELECT id FROM categories
                 WHERE name = $3
                   AND (tenant_id = $1 OR tenant_id IS NULL)
                 LIMIT 1
              )
        WHERE t.id IN (SELECT id FROM targets)
       RETURNING t.id`,
      params,
    );
    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorKind: 'tenant_user',
      action: 'assistant.bulk_recategorize',
      targetKind: 'transactions',
      targetId: null,
      details: {
        descriptionContains: i.descriptionContains,
        categoryName: i.categoryName,
        startDate: i.startDate ?? null,
        endDate: i.endDate ?? null,
        count: r.rowCount,
      },
    });
    return { updated: r.rowCount, cap: BULK_LIMIT };
  },
};

const createBudget: AssistantTool = {
  name: 'create_budget',
  description:
    'Set (or create) a monthly budget for a category. amountCents must be POSITIVE (the budget is the spending cap; sign convention is enforced by the DB CHECK). Optional periodMonth defaults to the current calendar month. Use categoryName="" for the flex-pool row.',
  kind: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      categoryName: { type: 'string', description: 'Empty string = flex-pool row' },
      amountCents: { type: 'integer', minimum: 1 },
      periodMonth: {
        type: 'string',
        description: 'First-of-month ISO date; defaults to current month',
      },
    },
    required: ['categoryName', 'amountCents'],
  },
  async execute(ctx, input) {
    const i = input as { categoryName: string; amountCents: number; periodMonth?: string };
    if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) {
      throw new Error('amountCents must be a positive integer');
    }
    let categoryId: string | null = null;
    if (i.categoryName !== '') {
      const cat = await pool.query<{ id: string }>(
        `SELECT id FROM categories
          WHERE name = $1 AND (tenant_id = $2 OR tenant_id IS NULL)
          LIMIT 1`,
        [i.categoryName, ctx.tenantId],
      );
      if (cat.rowCount === 0) {
        throw new Error(`Category "${i.categoryName}" not found`);
      }
      categoryId = cat.rows[0]!.id;
    }
    const period = i.periodMonth ?? null;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO budgets (tenant_id, period_month, category_id, amount_cents)
       VALUES ($1, COALESCE($2::date, date_trunc('month', CURRENT_DATE)::date), $3, $4)
       ON CONFLICT (period_month, COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET amount_cents = EXCLUDED.amount_cents
       RETURNING id`,
      [ctx.tenantId, period, categoryId, i.amountCents],
    );
    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorKind: 'tenant_user',
      action: 'assistant.create_budget',
      targetKind: 'budget',
      targetId: r.rows[0]!.id,
      details: {
        categoryName: i.categoryName,
        amountCents: i.amountCents,
        periodMonth: i.periodMonth ?? null,
      },
    });
    return { id: r.rows[0]!.id };
  },
};

const markBillPaid: AssistantTool = {
  name: 'mark_bill_paid',
  description: 'Mark a bill as paid; advances next_due by its frequency.',
  kind: 'write',
  inputSchema: {
    type: 'object',
    properties: { billId: { type: 'string' } },
    required: ['billId'],
  },
  async execute(ctx, input) {
    const i = input as { billId: string };
    const r = await pool.query(
      `UPDATE bills
          SET next_due_date = CASE frequency
                          WHEN 'weekly'   THEN next_due_date + INTERVAL '7 days'
                          WHEN 'biweekly' THEN next_due_date + INTERVAL '14 days'
                          WHEN 'monthly'  THEN next_due_date + INTERVAL '1 month'
                          WHEN 'yearly'   THEN next_due_date + INTERVAL '1 year'
                          ELSE next_due_date + INTERVAL '1 month'
                         END
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, next_due_date::text AS next_due`,
      [i.billId, ctx.tenantId],
    );
    if (r.rowCount === 0) throw new Error(`Bill ${i.billId} not found in this tenant`);
    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorKind: 'tenant_user',
      action: 'assistant.mark_bill_paid',
      targetKind: 'bill',
      targetId: i.billId,
      details: { nextDue: r.rows[0]!.next_due },
    });
    return r.rows[0];
  },
};

const createSavingsGoal: AssistantTool = {
  name: 'create_savings_goal',
  description:
    'Create a new savings goal for the user. Use this when the user wants to track a new savings target (down payment, vacation fund) OR a debt-payoff target (treat the debt amount as the target, current=0, contributions accumulate as payments). Returns the new goal id, which the assistant can immediately reference in follow-up tool calls (e.g. update_savings_goal to add an initial contribution).',
  kind: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Display name; 1–80 chars.' },
      targetAmountCents: {
        type: 'integer',
        description: 'Target balance to reach, in cents. Must be > 0.',
      },
      currentAmountCents: {
        type: 'integer',
        description: 'Optional starting balance, default 0.',
      },
      targetDate: {
        type: 'string',
        description:
          'Optional target date in YYYY-MM-DD format. Use this when the user has a specific deadline (e.g. pay off CC in 36 months).',
      },
    },
    required: ['name', 'targetAmountCents'],
  },
  async execute(ctx, input) {
    const i = input as {
      name?: string;
      targetAmountCents?: number;
      currentAmountCents?: number;
      targetDate?: string;
    };
    const name = (i.name ?? '').trim();
    if (name === '' || name.length > 80) {
      throw new Error('name must be 1–80 characters');
    }
    if (typeof i.targetAmountCents !== 'number' || i.targetAmountCents <= 0) {
      throw new Error('targetAmountCents must be a positive integer');
    }
    const current = typeof i.currentAmountCents === 'number' ? i.currentAmountCents : 0;
    if (current < 0) throw new Error('currentAmountCents must be ≥ 0');
    const targetDate =
      typeof i.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.targetDate)
        ? i.targetDate
        : null;
    const r = await pool.query<{
      id: string;
      name: string;
      target_amount_cents: number;
      current_amount_cents: number;
      target_date: string | null;
    }>(
      `INSERT INTO savings_goals
         (tenant_id, name, target_amount_cents, current_amount_cents, target_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, target_amount_cents, current_amount_cents, target_date::text`,
      [ctx.tenantId, name, i.targetAmountCents, current, targetDate],
    );
    const goal = r.rows[0]!;
    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorKind: 'tenant_user',
      action: 'assistant.create_savings_goal',
      targetKind: 'savings_goal',
      targetId: goal.id,
      details: {
        name,
        targetAmountCents: i.targetAmountCents,
        currentAmountCents: current,
        targetDate,
      },
    });
    return goal;
  },
};

const updateSavingsGoal: AssistantTool = {
  name: 'update_savings_goal',
  description:
    'Add to (or set) the current amount of a savings goal. Pass deltaCents to add, or currentCents to overwrite.',
  kind: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      goalId: { type: 'string' },
      deltaCents: { type: 'integer' },
      currentCents: { type: 'integer' },
    },
    required: ['goalId'],
  },
  async execute(ctx, input) {
    const i = input as { goalId: string; deltaCents?: number; currentCents?: number };
    if (typeof i.deltaCents !== 'number' && typeof i.currentCents !== 'number') {
      throw new Error('Pass deltaCents or currentCents');
    }
    const r = await pool.query<{ id: string; current_amount_cents: number }>(
      typeof i.currentCents === 'number'
        ? `UPDATE savings_goals SET current_amount_cents = $3
             WHERE id = $1 AND tenant_id = $2
             RETURNING id, current_amount_cents`
        : `UPDATE savings_goals SET current_amount_cents = current_amount_cents + $3
             WHERE id = $1 AND tenant_id = $2
             RETURNING id, current_amount_cents`,
      [i.goalId, ctx.tenantId, i.currentCents ?? i.deltaCents],
    );
    if (r.rowCount === 0) throw new Error(`Goal ${i.goalId} not found in this tenant`);
    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorKind: 'tenant_user',
      action: 'assistant.update_savings_goal',
      targetKind: 'savings_goal',
      targetId: i.goalId,
      details: { deltaCents: i.deltaCents ?? null, currentCents: i.currentCents ?? null },
    });
    return r.rows[0];
  },
};

const taxYearSummary: AssistantTool = {
  name: 'tax_year_summary',
  description:
    'Year-end tax aggregation. Rolls up every transaction whose category has a tax_category set, over Jan 1 – Dec 31 of the given year. Returns per-tax-category totals split by income vs deductible, plus the underlying contributing categories. Transfers excluded.',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      year: { type: 'integer', minimum: 1900, maximum: 2200 },
    },
    required: ['year'],
  },
  async execute(ctx, input) {
    const i = input as { year: number };
    const startDate = `${i.year}-01-01`;
    const endDate = `${i.year}-12-31`;
    const r = await pool.query(
      `SELECT c.tax_category, c.name AS category_name,
              SUM(t.amount_cents)::bigint AS total_cents,
              COUNT(*)::int AS txn_count
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN categories c ON c.id = t.category_id
        WHERE a.tenant_id = $1
          AND c.tax_category IS NOT NULL
          AND t.txn_date BETWEEN $2::date AND $3::date
          AND t.transfer_group_id IS NULL
        GROUP BY c.tax_category, c.name
        ORDER BY c.tax_category, c.name`,
      [ctx.tenantId, startDate, endDate],
    );
    return { year: i.year, rows: r.rows };
  },
};

const cryptoHoldings: AssistantTool = {
  name: 'crypto_holdings_summary',
  description:
    'List the tenant\'s crypto holdings with quantity, last price (cents), market value, and unrealized gain. Use this to answer "what crypto do I hold?" or "what is my crypto P&L?".',
  kind: 'read',
  inputSchema: { type: 'object', properties: {} },
  async execute(ctx) {
    const r = await pool.query(
      `SELECT h.id, h.symbol, h.name, h.quantity::float8 AS quantity,
              h.cost_basis_cents, h.last_price_cents,
              h.last_price_date::text AS last_price_date,
              (h.quantity * h.last_price_cents)::bigint AS market_value_cents,
              (h.quantity * h.last_price_cents)::bigint - h.cost_basis_cents
                AS unrealized_gain_cents,
              a.name AS account_name
         FROM holdings h
         JOIN accounts a ON a.id = h.account_id
        WHERE a.tenant_id = $1 AND h.asset_type = 'crypto'
        ORDER BY h.symbol`,
      [ctx.tenantId],
    );
    return { holdings: r.rows };
  },
};

const calendarMonth: AssistantTool = {
  name: 'calendar_month_summary',
  description:
    'Per-day spend + income totals for a calendar month plus bills due in that month. Useful for "what does my May calendar look like?" or "which day did I spend the most?".',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      month: { type: 'string', description: 'YYYY-MM (defaults to current month)' },
    },
  },
  async execute(ctx, input) {
    const i = input as { month?: string };
    const now = new Date();
    const month =
      i.month ||
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const m = month.match(/^(\d{4})-(\d{2})$/);
    if (!m) throw new Error('month must be YYYY-MM');
    const monthStart = `${m[1]}-${m[2]}-01`;

    const days = await pool.query(
      `SELECT t.txn_date::text AS date,
              COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END), 0)::bigint
                AS spend_cents,
              COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END), 0)::bigint
                AS income_cents,
              COUNT(*)::int AS txn_count
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.tenant_id = $1
          AND t.txn_date >= $2::date
          AND t.txn_date <  (date_trunc('month', $2::date) + interval '1 month')::date
        GROUP BY t.txn_date
        ORDER BY t.txn_date`,
      [ctx.tenantId, monthStart],
    );
    const bills = await pool.query(
      `SELECT id, name, next_due_date::text AS next_due, amount_cents
         FROM bills
        WHERE tenant_id = $1 AND active = true
          AND next_due_date >= $2::date
          AND next_due_date <  (date_trunc('month', $2::date) + interval '1 month')::date
        ORDER BY next_due_date`,
      [ctx.tenantId, monthStart],
    );
    return { month, days: days.rows, bills: bills.rows };
  },
};

const shareSummary: AssistantTool = {
  name: 'share_summary',
  description:
    'Net amount each split participant owes the tenant. share_cents > 0 = they owe you; < 0 = you owe them. open_count counts unsettled rows.',
  kind: 'read',
  inputSchema: { type: 'object', properties: {} },
  async execute(ctx) {
    const r = await pool.query(
      `SELECT p.id AS participant_id, p.name,
              COALESCE(SUM(CASE WHEN s.settled = false THEN s.share_cents ELSE 0 END), 0)::bigint
                AS net_open_cents,
              COUNT(s.id) FILTER (WHERE s.settled = false)::int AS open_count
         FROM split_participants p
         LEFT JOIN transaction_shares s ON s.participant_id = p.id
        WHERE p.tenant_id = $1 AND p.archived = false
        GROUP BY p.id, p.name
        ORDER BY p.name`,
      [ctx.tenantId],
    );
    return { summary: r.rows };
  },
};

const splitTransaction: AssistantTool = {
  name: 'split_transaction',
  description: `Split a transaction among one or more participants. Pass shares as an array of {participantName, shareCents}. Share signs must match the transaction sign (e.g. for a -10000 dinner, each participant's share is negative or positive — convention: positive cents = THEY owe you). The tenant's own share is whatever remains.`,
  kind: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      transactionId: { type: 'string' },
      shares: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            participantName: { type: 'string' },
            shareCents: { type: 'integer' },
          },
          required: ['participantName', 'shareCents'],
        },
        minItems: 1,
      },
    },
    required: ['transactionId', 'shares'],
  },
  async execute(ctx, input) {
    const i = input as {
      transactionId: string;
      shares: Array<{ participantName: string; shareCents: number }>;
    };
    // Verify the transaction belongs to this tenant + get its amount.
    const txn = await pool.query<{ amount_cents: number }>(
      `SELECT t.amount_cents
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.id = $1 AND a.tenant_id = $2`,
      [i.transactionId, ctx.tenantId],
    );
    if (txn.rowCount === 0) {
      throw new Error(`Transaction ${i.transactionId} not found in this tenant`);
    }
    const txnAmount = Number(txn.rows[0]!.amount_cents);
    const total = i.shares.reduce((a, s) => a + s.shareCents, 0);
    if (Math.abs(total) > Math.abs(txnAmount)) {
      throw new Error('Total of shares exceeds the transaction amount');
    }
    // Look up / auto-create participants by name (tenant-scoped).
    const idByName = new Map<string, string>();
    for (const s of i.shares) {
      const name = s.participantName.trim();
      if (!name) throw new Error('Empty participant name');
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM split_participants WHERE tenant_id = $1 AND name = $2`,
        [ctx.tenantId, name],
      );
      if (existing.rowCount! > 0) {
        idByName.set(name, existing.rows[0]!.id);
      } else {
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO split_participants (tenant_id, name) VALUES ($1, $2)
           RETURNING id`,
          [ctx.tenantId, name],
        );
        idByName.set(name, inserted.rows[0]!.id);
      }
    }
    // Replace existing shares for this transaction.
    await pool.query(
      `DELETE FROM transaction_shares WHERE transaction_id = $1`,
      [i.transactionId],
    );
    for (const s of i.shares) {
      await pool.query(
        `INSERT INTO transaction_shares
           (transaction_id, participant_id, share_cents)
         VALUES ($1, $2, $3)`,
        [i.transactionId, idByName.get(s.participantName.trim()), s.shareCents],
      );
    }
    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorKind: 'tenant_user',
      action: 'assistant.split_transaction',
      targetKind: 'transaction',
      targetId: i.transactionId,
      details: {
        transactionAmountCents: txnAmount,
        shares: i.shares,
      },
    });
    return { ok: true, sharesWritten: i.shares.length };
  },
};

export const ASSISTANT_TOOLS: AssistantTool[] = [
  queryTransactions,
  accountBalances,
  listCategories,
  spendingByCategory,
  listBudgets,
  listBills,
  listGoals,
  cryptoHoldings,
  calendarMonth,
  taxYearSummary,
  shareSummary,
  updateTransactionCategory,
  bulkRecategorize,
  createBudget,
  markBillPaid,
  createSavingsGoal,
  updateSavingsGoal,
  splitTransaction,
];

export function findTool(name: string): AssistantTool | undefined {
  return ASSISTANT_TOOLS.find((t) => t.name === name);
}

export function describeToolsForAnthropic(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return ASSISTANT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
