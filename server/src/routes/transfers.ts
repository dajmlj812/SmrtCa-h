import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import {
  detectTransfers,
  linkTransfer,
  unlinkTransfer,
} from '../domain/transfers.js';
import { assertAccountInTenant, requireTenant } from '../auth/rbac.js';
import { isUuid } from '../util.js';

interface TransferLeg {
  id: string;
  account_id: string;
  account_name: string;
  txn_date: string;
  amount_cents: number;
  raw_description: string;
  normalized_merchant: string | null;
}

interface TransferGroupRow extends TransferLeg {
  transfer_group_id: string;
}

/**
 * 0.14.2 — tenant-scoped. The list endpoint joins through accounts
 * so cross-tenant transfer groups are invisible. POST verifies the
 * supplied `accountId` (on detect) and routes link/unlink through
 * the domain functions, which require tenantId.
 */
export async function transferRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/transfers/detect', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as { accountId?: unknown };
    const accountIdRaw =
      typeof body.accountId === 'string' && body.accountId.trim() !== ''
        ? body.accountId.trim()
        : undefined;
    if (accountIdRaw && !isUuid(accountIdRaw)) {
      return reply.code(400).send({ error: 'Invalid accountId' });
    }
    if (accountIdRaw) {
      const ok = await assertAccountInTenant(tenantId, accountIdRaw);
      if (!ok) return reply.code(404).send({ error: 'Account not found' });
    }
    const summary = await detectTransfers({
      tenantId,
      ...(accountIdRaw ? { accountId: accountIdRaw } : {}),
    });
    return { summary };
  });

  // List all transfer groups WITHIN THIS TENANT, each with both legs
  // joined to their accounts. A group with legs spanning two tenants
  // (impossible under the 0.14.2 detector but possible from legacy
  // data) would only show its caller-tenant legs.
  app.get('/api/transfers', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const rows = await query<TransferGroupRow>(
      `SELECT t.id, t.account_id, t.txn_date, t.amount_cents,
              t.raw_description, t.normalized_merchant, t.transfer_group_id,
              a.name AS account_name
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.tenant_id = $1
          AND t.transfer_group_id IS NOT NULL
        ORDER BY t.transfer_group_id, t.txn_date`,
      [tenantId],
    );

    const byGroup = new Map<string, TransferLeg[]>();
    for (const row of rows.rows) {
      const list = byGroup.get(row.transfer_group_id) ?? [];
      list.push({
        id: row.id,
        account_id: row.account_id,
        account_name: row.account_name,
        txn_date: row.txn_date,
        amount_cents: row.amount_cents,
        raw_description: row.raw_description,
        normalized_merchant: row.normalized_merchant,
      });
      byGroup.set(row.transfer_group_id, list);
    }
    const transfers = Array.from(byGroup.entries()).map(
      ([group_id, legs]) => ({ group_id, transactions: legs }),
    );
    return { transfers };
  });

  // Manual link: pair two transactions into a new transfer group.
  // Domain function enforces tenant ownership on both legs.
  app.post('/api/transfers', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as { aId?: unknown; bId?: unknown };
    const aId = typeof body.aId === 'string' ? body.aId : '';
    const bId = typeof body.bId === 'string' ? body.bId : '';
    if (!isUuid(aId) || !isUuid(bId)) {
      return reply.code(400).send({ error: 'aId and bId must be valid UUIDs' });
    }
    try {
      const result = await linkTransfer(aId, bId, tenantId);
      return reply.code(201).send({ groupId: result.groupId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to link';
      return reply.code(400).send({ error: message });
    }
  });

  // Unlink an entire transfer group. Domain function only touches
  // legs whose account is in this tenant, so a 0-rowcount on a real
  // group from another tenant returns the same 404 as a stale id.
  app.delete<{ Params: { groupId: string } }>(
    '/api/transfers/:groupId',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.groupId)) {
        return reply.code(400).send({ error: 'Invalid groupId' });
      }
      const cleared = await unlinkTransfer(req.params.groupId, tenantId);
      if (cleared === 0) {
        return reply.code(404).send({ error: 'Transfer group not found' });
      }
      return reply.code(204).send();
    },
  );
}
