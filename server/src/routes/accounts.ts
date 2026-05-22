import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { ACCOUNT_TYPES, type AccountType } from '../import/types.js';
import { isUuid } from '../util.js';

/** Coerce an unknown request-body field to a trimmed string (or ''). */
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // List accounts with computed balance + transaction count.
  app.get('/api/accounts', async () => {
    const result = await query(`
      SELECT
        a.id, a.name, a.institution, a.type, a.last4, a.currency, a.created_at,
        COALESCE(SUM(t.amount_cents), 0)::bigint AS balance_cents,
        COUNT(t.id)::bigint                       AS transaction_count
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
                COALESCE(SUM(t.amount_cents), 0)::bigint AS balance_cents,
                COUNT(t.id)::bigint                       AS transaction_count
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
