import type { FastifyInstance } from 'fastify';
import { query, pool } from '../db/pool.js';
import { isUuid } from '../util.js';
import { requireTenant } from '../auth/rbac.js';

/**
 * 0.21.2 — warranty/return-window tracker.
 *
 * Receipts that have a warranty get a row here so we can warn
 * the user before the coverage runs out. The list endpoint
 * sorts by warranty_until ASC so "expiring soonest" is at the
 * top of the page; status filter narrows to active / expired /
 * expiring-soon.
 */

const WARRANTY_COLUMNS = `
  id, transaction_id, attachment_id, item, vendor,
  purchase_date::text AS purchase_date,
  warranty_until::text AS warranty_until,
  purchase_cents, notes, created_at,
  (warranty_until < CURRENT_DATE) AS expired,
  (warranty_until >= CURRENT_DATE
   AND warranty_until <= CURRENT_DATE + INTERVAL '30 days') AS expiring_soon`;

interface Input {
  item: string;
  vendor: string | null;
  purchaseDate: string;
  warrantyUntil: string;
  purchaseCents: number | null;
  notes: string | null;
  transactionId: string | null;
  attachmentId: string | null;
}

function parse(body: unknown): Input | string {
  if (!body || typeof body !== 'object') return 'body required';
  const b = body as Record<string, unknown>;
  if (typeof b.item !== 'string' || !b.item.trim()) return 'item required';
  if (typeof b.purchaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.purchaseDate)) {
    return 'purchaseDate must be YYYY-MM-DD';
  }
  if (typeof b.warrantyUntil !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.warrantyUntil)) {
    return 'warrantyUntil must be YYYY-MM-DD';
  }
  if (b.warrantyUntil < b.purchaseDate) return 'warrantyUntil must be >= purchaseDate';
  let txnId: string | null = null;
  if (b.transactionId !== undefined && b.transactionId !== null) {
    if (typeof b.transactionId !== 'string' || !isUuid(b.transactionId)) {
      return 'transactionId must be a UUID or null';
    }
    txnId = b.transactionId;
  }
  let attId: string | null = null;
  if (b.attachmentId !== undefined && b.attachmentId !== null) {
    if (typeof b.attachmentId !== 'string' || !isUuid(b.attachmentId)) {
      return 'attachmentId must be a UUID or null';
    }
    attId = b.attachmentId;
  }
  let cents: number | null = null;
  if (b.purchaseCents !== undefined && b.purchaseCents !== null) {
    const n = Number(b.purchaseCents);
    if (!Number.isInteger(n) || n < 0) return 'purchaseCents must be a non-negative integer';
    cents = n;
  }
  return {
    item: b.item.trim(),
    vendor: typeof b.vendor === 'string' && b.vendor.trim() ? b.vendor.trim() : null,
    purchaseDate: b.purchaseDate,
    warrantyUntil: b.warrantyUntil,
    purchaseCents: cents,
    notes: typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null,
    transactionId: txnId,
    attachmentId: attId,
  };
}

async function transactionInTenant(tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.id = $1 AND a.tenant_id = $2`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

async function attachmentInTenant(tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM attachments att
       JOIN transactions t ON t.id = att.transaction_id
       JOIN accounts a ON a.id = t.account_id
      WHERE att.id = $1 AND a.tenant_id = $2`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function warrantyRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string } }>(
    '/api/warranties',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const where: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (req.query.status === 'active') {
        where.push(`warranty_until >= CURRENT_DATE`);
      } else if (req.query.status === 'expired') {
        where.push(`warranty_until < CURRENT_DATE`);
      } else if (req.query.status === 'expiring') {
        where.push(
          `warranty_until BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`,
        );
      }
      const r = await query(
        `SELECT ${WARRANTY_COLUMNS}
           FROM warranties
          WHERE ${where.join(' AND ')}
          ORDER BY warranty_until ASC`,
        params,
      );
      return { warranties: r.rows };
    },
  );

  app.post('/api/warranties', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const parsed = parse(req.body);
    if (typeof parsed === 'string') return reply.code(400).send({ error: parsed });
    if (parsed.transactionId && !(await transactionInTenant(tenantId, parsed.transactionId))) {
      return reply.code(400).send({ error: 'transactionId not found' });
    }
    if (parsed.attachmentId && !(await attachmentInTenant(tenantId, parsed.attachmentId))) {
      return reply.code(400).send({ error: 'attachmentId not found' });
    }
    const r = await query(
      `INSERT INTO warranties
         (tenant_id, transaction_id, attachment_id, item, vendor,
          purchase_date, warranty_until, purchase_cents, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${WARRANTY_COLUMNS}`,
      [
        tenantId, parsed.transactionId, parsed.attachmentId,
        parsed.item, parsed.vendor, parsed.purchaseDate, parsed.warrantyUntil,
        parsed.purchaseCents, parsed.notes,
      ],
    );
    return reply.code(201).send({ warranty: r.rows[0] });
  });

  app.patch<{ Params: { id: string } }>('/api/warranties/:id', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isUuid(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const parsed = parse(req.body);
    if (typeof parsed === 'string') return reply.code(400).send({ error: parsed });
    if (parsed.transactionId && !(await transactionInTenant(tenantId, parsed.transactionId))) {
      return reply.code(400).send({ error: 'transactionId not found' });
    }
    if (parsed.attachmentId && !(await attachmentInTenant(tenantId, parsed.attachmentId))) {
      return reply.code(400).send({ error: 'attachmentId not found' });
    }
    const r = await query(
      `UPDATE warranties
          SET transaction_id = $1, attachment_id = $2, item = $3, vendor = $4,
              purchase_date = $5, warranty_until = $6,
              purchase_cents = $7, notes = $8
        WHERE id = $9 AND tenant_id = $10
        RETURNING ${WARRANTY_COLUMNS}`,
      [
        parsed.transactionId, parsed.attachmentId, parsed.item, parsed.vendor,
        parsed.purchaseDate, parsed.warrantyUntil, parsed.purchaseCents, parsed.notes,
        req.params.id, tenantId,
      ],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: 'warranty not found' });
    return { warranty: r.rows[0] };
  });

  app.delete<{ Params: { id: string } }>('/api/warranties/:id', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    if (!isUuid(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const r = await query(
      'DELETE FROM warranties WHERE id = $1 AND tenant_id = $2',
      [req.params.id, tenantId],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: 'warranty not found' });
    return reply.code(204).send();
  });
}

/**
 * Returns ALL tenants' warranties expiring in the next `days`
 * days. Used by the daily insights scheduler to seed
 * insight_cards. Excludes already-expired rows.
 */
export async function findExpiringWarranties(days = 30): Promise<
  Array<{
    id: string;
    tenant_id: string;
    item: string;
    vendor: string | null;
    warranty_until: string;
    days_remaining: number;
  }>
> {
  const r = await pool.query<{
    id: string;
    tenant_id: string;
    item: string;
    vendor: string | null;
    warranty_until: string;
    days_remaining: string;
  }>(
    `SELECT id, tenant_id, item, vendor,
            warranty_until::text AS warranty_until,
            (warranty_until - CURRENT_DATE)::int AS days_remaining
       FROM warranties
      WHERE warranty_until >= CURRENT_DATE
        AND warranty_until <= CURRENT_DATE + ($1::int || ' days')::interval
      ORDER BY warranty_until ASC`,
    [days],
  );
  return r.rows.map((row) => ({
    ...row,
    days_remaining: Number(row.days_remaining),
  }));
}
