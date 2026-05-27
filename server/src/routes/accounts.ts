import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { ACCOUNT_TYPES, type AccountType } from '../import/types.js';
import { isUuid } from '../util.js';
import {
  assertAccountWriteAccess,
  loadUserContext,
  requireTenant,
  scopedAccountIds,
} from '../auth/rbac.js';
import { FEATURES, requireFeature } from '../auth/entitlements.js';
import { convert, getDisplayCurrency, loadRatesSnapshot } from '../domain/fx.js';

/** Coerce an unknown request-body field to a trimmed string (or ''). */
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// True balance: opening_balance_cents + sum of amounts on/after opening date
// (or sum of all amounts when opening_balance_date is null). Closes KI-01.
// For investment accounts, the holdings' market value (quantity × last
// price) is added on top in the SELECT so balance_cents always
// represents the account's total worth. holdings_value_cents is
// exposed separately for the UI.
const BALANCE_SELECT = `
  a.opening_balance_cents
    + COALESCE(SUM(t.amount_cents) FILTER (
        WHERE a.opening_balance_date IS NULL
           OR t.txn_date >= a.opening_balance_date
      ), 0)
    + COALESCE((
        SELECT SUM(h.quantity * h.last_price_cents)::bigint
          FROM holdings h
         WHERE h.account_id = a.id
      ), 0)
`;
const HOLDINGS_VALUE = `
  COALESCE((
    SELECT SUM(h.quantity * h.last_price_cents)::bigint
      FROM holdings h
     WHERE h.account_id = a.id
  ), 0)
`;

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // List accounts with computed balance + transaction count. Tenant-
  // scoped + role-aware: children see only the accounts the admin
  // assigned to them via account_user_access; admins + spouses see
  // every account WITHIN THEIR TENANT (the new tenant filter prevents
  // the pre-0.14.0 leak where any logged-in user saw every tenant's
  // accounts).
  app.get('/api/accounts', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const ctx = await loadUserContext(req.user!.id, tenantId);
    const scopedIds = await scopedAccountIds(ctx);
    if (scopedIds && scopedIds.length === 0) {
      return { accounts: [], display_currency: await getDisplayCurrency() };
    }
    const params: unknown[] = [tenantId];
    let scopeClause = `WHERE a.tenant_id = $1`;
    if (scopedIds && scopedIds.length > 0) {
      params.push(scopedIds);
      scopeClause += ` AND a.id = ANY($${params.length}::uuid[])`;
    }
    const result = await query<{
      id: string;
      name: string;
      institution: string | null;
      type: string;
      last4: string | null;
      currency: string;
      created_at: string;
      opening_balance_cents: number;
      opening_balance_date: string | null;
      balance_cents: number;
      holdings_value_cents: number;
      transaction_count: number;
    }>(
      `SELECT
        a.id, a.name, a.institution, a.type, a.last4, a.currency, a.created_at,
        a.opening_balance_cents, a.opening_balance_date,
        a.interest_rate_apr, a.min_payment_cents, a.credit_limit_cents,
        (${BALANCE_SELECT})::bigint           AS balance_cents,
        (${HOLDINGS_VALUE})::bigint            AS holdings_value_cents,
        COUNT(t.id)::bigint                    AS transaction_count
      FROM accounts a
      LEFT JOIN transactions t ON t.account_id = a.id
      ${scopeClause}
      GROUP BY a.id
      ORDER BY a.created_at`,
      params,
    );
    const display = await getDisplayCurrency();
    const snapshot = await loadRatesSnapshot();
    const accounts = result.rows.map((row) => {
      const cv = convert(Number(row.balance_cents), row.currency, display, snapshot);
      return {
        ...row,
        display_currency: display,
        balance_display_cents: cv.cents,
        rate_known: cv.rateKnown,
      };
    });
    return { accounts, display_currency: display };
  });

  app.get<{ Params: { id: string } }>(
    '/api/accounts/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid account id' });
      }
      // tenant_id in the WHERE means cross-tenant probes 404 just like
      // a truly-unknown id — no id-enumeration leak.
      const result = await query(
        `SELECT a.id, a.name, a.institution, a.type, a.last4, a.currency,
                a.created_at,
                a.opening_balance_cents, a.opening_balance_date,
                a.interest_rate_apr, a.min_payment_cents, a.credit_limit_cents,
                (${BALANCE_SELECT})::bigint           AS balance_cents,
                (${HOLDINGS_VALUE})::bigint            AS holdings_value_cents,
                COUNT(t.id)::bigint                    AS transaction_count
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
         WHERE a.id = $1 AND a.tenant_id = $2
         GROUP BY a.id`,
        [req.params.id, tenantId],
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Account not found' });
      }
      return { account: result.rows[0] };
    },
  );

  app.post('/api/accounts', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const name = asString(body.name);
    if (name === '') {
      return reply.code(400).send({ error: 'Account name is required' });
    }
    const type = asString(body.type);
    if (!ACCOUNT_TYPES.includes(type as AccountType)) {
      return reply.code(400).send({
        error: `Account type must be one of: ${ACCOUNT_TYPES.join(', ')}`,
      });
    }
    const institution = asString(body.institution) || null;
    const last4 = asString(body.last4) || null;
    const currency = (asString(body.currency) || 'USD').toUpperCase();

    // 0.15.2: non-USD accounts require the MULTI_CURRENCY feature.
    // USD-only is the Starter default; Plus/Family unlock the rest.
    if (currency !== 'USD') {
      const deny = await requireFeature(tenantId, FEATURES.MULTI_CURRENCY);
      if (deny) return reply.code(deny.status).send({ error: deny.error });
    }

    const result = await query(
      `INSERT INTO accounts (tenant_id, name, institution, type, last4, currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, institution, type, last4, currency, created_at`,
      [tenantId, name, institution, type, last4, currency],
    );
    return reply.code(201).send({ account: result.rows[0] });
  });

  // Edit account fields including opening balance and "as of" date.
  app.patch<{ Params: { id: string } }>(
    '/api/accounts/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid account id' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updates: string[] = [];
      const params: unknown[] = [];

      if (body.name !== undefined) {
        const name = asString(body.name);
        if (name === '') {
          return reply.code(400).send({ error: 'Name cannot be empty' });
        }
        params.push(name);
        updates.push(`name = $${params.length}`);
      }
      if (body.institution !== undefined) {
        params.push(asString(body.institution) || null);
        updates.push(`institution = $${params.length}`);
      }
      if (body.last4 !== undefined) {
        params.push(asString(body.last4) || null);
        updates.push(`last4 = $${params.length}`);
      }
      if (body.opening_balance_cents !== undefined) {
        const raw = body.opening_balance_cents;
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isInteger(n)) {
          return reply
            .code(400)
            .send({ error: 'opening_balance_cents must be an integer' });
        }
        params.push(n);
        updates.push(`opening_balance_cents = $${params.length}`);
      }
      if (body.opening_balance_date !== undefined) {
        if (body.opening_balance_date === null) {
          params.push(null);
        } else if (
          typeof body.opening_balance_date === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(body.opening_balance_date)
        ) {
          params.push(body.opening_balance_date);
        } else {
          return reply
            .code(400)
            .send({ error: 'opening_balance_date must be YYYY-MM-DD or null' });
        }
        updates.push(`opening_balance_date = $${params.length}`);
      }
      // 0.18.6 — debt fields. Null clears; values are bounded by
      // the CHECK constraints in migration 047.
      if (body.interest_rate_apr !== undefined) {
        if (body.interest_rate_apr === null) {
          params.push(null);
        } else {
          const n = Number(body.interest_rate_apr);
          if (!Number.isFinite(n) || n < 0 || n > 100) {
            return reply
              .code(400)
              .send({ error: 'interest_rate_apr must be 0-100 or null' });
          }
          params.push(n);
        }
        updates.push(`interest_rate_apr = $${params.length}`);
      }
      if (body.min_payment_cents !== undefined) {
        if (body.min_payment_cents === null) {
          params.push(null);
        } else {
          const n =
            typeof body.min_payment_cents === 'number'
              ? body.min_payment_cents
              : Number(body.min_payment_cents);
          if (!Number.isInteger(n) || n <= 0) {
            return reply
              .code(400)
              .send({ error: 'min_payment_cents must be a positive integer or null' });
          }
          params.push(n);
        }
        updates.push(`min_payment_cents = $${params.length}`);
      }
      // 0.22.2 — credit limit (used by payoff goals targeting an
      // X% utilization ratio). Meaningful on credit_card accounts;
      // accepted on any row but ignored elsewhere.
      if (body.credit_limit_cents !== undefined) {
        if (body.credit_limit_cents === null) {
          params.push(null);
        } else {
          const n =
            typeof body.credit_limit_cents === 'number'
              ? body.credit_limit_cents
              : Number(body.credit_limit_cents);
          if (!Number.isInteger(n) || n <= 0) {
            return reply
              .code(400)
              .send({ error: 'credit_limit_cents must be a positive integer or null' });
          }
          params.push(n);
        }
        updates.push(`credit_limit_cents = $${params.length}`);
      }

      if (updates.length === 0) {
        return reply
          .code(400)
          .send({ error: 'No updatable fields provided' });
      }

      params.push(req.params.id);
      const idIdx = params.length;
      params.push(tenantId);
      const tenantIdx = params.length;
      const result = await query(
        `UPDATE accounts SET ${updates.join(', ')}
          WHERE id = $${idIdx} AND tenant_id = $${tenantIdx}
       RETURNING id, name, institution, type, last4, currency, created_at,
                 opening_balance_cents, opening_balance_date,
                 interest_rate_apr, min_payment_cents, credit_limit_cents`,
        params,
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Account not found' });
      }
      return { account: result.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/accounts/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid account id' });
      }
      const result = await query(
        'DELETE FROM accounts WHERE id = $1 AND tenant_id = $2',
        [req.params.id, tenantId],
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Account not found' });
      }
      return reply.code(204).send();
    },
  );

  // 0.19.2 — cleared/uncleared reconciliation endpoints.
  //
  // GET /api/accounts/:id/cleared-balance?asOf=YYYY-MM-DD
  //   Returns the balance computed from CLEARED transactions only
  //   through asOf (inclusive). Used by the Reconcile workflow to
  //   show "your current cleared balance" so the user can compare
  //   against the statement.
  app.get<{
    Params: { id: string };
    Querystring: { asOf?: string };
  }>('/api/accounts/:id/cleared-balance', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isUuid(req.params.id)) {
      return reply.code(400).send({ error: 'Invalid account id' });
    }
    const asOf = (req.query.asOf ?? '').trim();
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      return reply.code(400).send({ error: 'asOf must be YYYY-MM-DD' });
    }
    const r = await query<{
      cleared_balance_cents: string;
      uncleared_count: string;
      uncleared_sum_cents: string;
    }>(
      `SELECT
         COALESCE(a.opening_balance_cents, 0)
           + COALESCE(SUM(t.amount_cents) FILTER (
               WHERE t.cleared_at IS NOT NULL
                 AND ($2::date IS NULL OR t.cleared_at::date <= $2::date)
                 AND (a.opening_balance_date IS NULL OR t.txn_date >= a.opening_balance_date)
             ), 0)::bigint AS cleared_balance_cents,
         COUNT(*) FILTER (
           WHERE t.cleared_at IS NULL
             AND ($2::date IS NULL OR t.txn_date <= $2::date)
             AND (a.opening_balance_date IS NULL OR t.txn_date >= a.opening_balance_date)
         )::bigint AS uncleared_count,
         COALESCE(SUM(t.amount_cents) FILTER (
           WHERE t.cleared_at IS NULL
             AND ($2::date IS NULL OR t.txn_date <= $2::date)
             AND (a.opening_balance_date IS NULL OR t.txn_date >= a.opening_balance_date)
         ), 0)::bigint AS uncleared_sum_cents
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
      WHERE a.id = $1 AND a.tenant_id = $3
      GROUP BY a.opening_balance_cents`,
      [req.params.id, asOf || null, tenantId],
    );
    if (r.rowCount === 0) {
      return reply.code(404).send({ error: 'Account not found' });
    }
    const row = r.rows[0]!;
    return {
      account_id: req.params.id,
      as_of: asOf || new Date().toISOString().slice(0, 10),
      cleared_balance_cents: Number(row.cleared_balance_cents),
      uncleared_count: Number(row.uncleared_count),
      uncleared_sum_cents: Number(row.uncleared_sum_cents),
    };
  });

  // POST /api/accounts/:id/reconcile
  //   Body: { statementDate: 'YYYY-MM-DD', transactionIds: string[] }
  //   Bulk-sets cleared_at on the listed transactions. Refuses if any
  //   id doesn't belong to this account + tenant — partial success is
  //   the wrong UX for a reconciliation commit.
  app.post<{
    Params: { id: string };
    Body: { statementDate?: unknown; transactionIds?: unknown };
  }>('/api/accounts/:id/reconcile', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isUuid(req.params.id)) {
      return reply.code(400).send({ error: 'Invalid account id' });
    }
    const body = req.body ?? {};
    if (
      typeof body.statementDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.statementDate)
    ) {
      return reply
        .code(400)
        .send({ error: 'statementDate must be YYYY-MM-DD' });
    }
    if (!Array.isArray(body.transactionIds) || body.transactionIds.length === 0) {
      return reply
        .code(400)
        .send({ error: 'transactionIds must be a non-empty array' });
    }
    const ids = (body.transactionIds as unknown[]).filter(
      (x): x is string => typeof x === 'string' && isUuid(x),
    );
    if (ids.length !== body.transactionIds.length) {
      return reply
        .code(400)
        .send({ error: 'transactionIds contains non-UUID values' });
    }
    // Per-account write gate (mirrors transaction PATCH).
    const ctx = await loadUserContext(req.user!.id, tenantId);
    const denied = await assertAccountWriteAccess(ctx, req.params.id);
    if (denied) {
      return reply.code(denied.status).send({ error: denied.error });
    }
    // Verify every ID belongs to this account + tenant. A single
    // foreign id rejects the whole batch.
    const ownership = await query<{ id: string }>(
      `SELECT t.id FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.id = ANY($1::uuid[])
          AND a.id = $2
          AND a.tenant_id = $3`,
      [ids, req.params.id, tenantId],
    );
    if (ownership.rowCount !== ids.length) {
      return reply.code(400).send({
        error: `One or more transactionIds do not belong to this account (found ${ownership.rowCount}, expected ${ids.length})`,
      });
    }
    // Statement date as end-of-day UTC so cleared_at::date <= asOf
    // includes statement-day clears across timezones.
    const ts = `${body.statementDate}T23:59:59Z`;
    const updated = await query(
      `UPDATE transactions
          SET cleared_at = $1
        WHERE id = ANY($2::uuid[])`,
      [ts, ids],
    );
    return {
      reconciled: updated.rowCount ?? 0,
      statementDate: body.statementDate,
    };
  });
}
