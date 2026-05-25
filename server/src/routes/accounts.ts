import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { ACCOUNT_TYPES, type AccountType } from '../import/types.js';
import { isUuid } from '../util.js';
import {
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
        a.interest_rate_apr, a.min_payment_cents,
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
                a.interest_rate_apr, a.min_payment_cents,
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
                 interest_rate_apr, min_payment_cents`,
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
}
