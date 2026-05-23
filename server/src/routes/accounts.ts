import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { ACCOUNT_TYPES, type AccountType } from '../import/types.js';
import { isUuid } from '../util.js';

/** Coerce an unknown request-body field to a trimmed string (or ''). */
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// True balance: opening_balance_cents + sum of amounts on/after opening date
// (or sum of all amounts when opening_balance_date is null). Closes KI-01.
const BALANCE_SELECT = `
  a.opening_balance_cents
    + COALESCE(SUM(t.amount_cents) FILTER (
        WHERE a.opening_balance_date IS NULL
           OR t.txn_date >= a.opening_balance_date
      ), 0)
`;

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // List accounts with computed balance + transaction count.
  app.get('/api/accounts', async () => {
    const result = await query(`
      SELECT
        a.id, a.name, a.institution, a.type, a.last4, a.currency, a.created_at,
        a.opening_balance_cents, a.opening_balance_date,
        (${BALANCE_SELECT})::bigint           AS balance_cents,
        COUNT(t.id)::bigint                    AS transaction_count
      FROM accounts a
      LEFT JOIN transactions t ON t.account_id = a.id
      GROUP BY a.id
      ORDER BY a.created_at
    `);
    return { accounts: result.rows };
  });

  app.get<{ Params: { id: string } }>(
    '/api/accounts/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid account id' });
      }
      const result = await query(
        `SELECT a.id, a.name, a.institution, a.type, a.last4, a.currency,
                a.created_at,
                a.opening_balance_cents, a.opening_balance_date,
                (${BALANCE_SELECT})::bigint           AS balance_cents,
                COUNT(t.id)::bigint                    AS transaction_count
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
         WHERE a.id = $1
         GROUP BY a.id`,
        [req.params.id],
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Account not found' });
      }
      return { account: result.rows[0] };
    },
  );

  app.post('/api/accounts', async (req, reply) => {
    // Treat the body defensively — fields may be missing or the wrong type.
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
    const currency = asString(body.currency) || 'USD';

    const result = await query(
      `INSERT INTO accounts (name, institution, type, last4, currency)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, institution, type, last4, currency, created_at`,
      [name, institution, type, last4, currency],
    );
    return reply.code(201).send({ account: result.rows[0] });
  });

  // Edit account fields including opening balance and "as of" date.
  app.patch<{ Params: { id: string } }>(
    '/api/accounts/:id',
    async (req, reply) => {
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

      if (updates.length === 0) {
        return reply
          .code(400)
          .send({ error: 'No updatable fields provided' });
      }

      params.push(req.params.id);
      const result = await query(
        `UPDATE accounts SET ${updates.join(', ')}
          WHERE id = $${params.length}
       RETURNING id, name, institution, type, last4, currency, created_at,
                 opening_balance_cents, opening_balance_date`,
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
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid account id' });
      }
      const result = await query('DELETE FROM accounts WHERE id = $1', [
        req.params.id,
      ]);
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Account not found' });
      }
      return reply.code(204).send();
    },
  );
}
