import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';
import {
  canManageMembers,
  loadUserContext,
  requireFinancialMutation,
} from '../auth/rbac.js';
import {
  FEATURES,
  requireBankConnectionSlot,
  requireFeature,
} from '../auth/entitlements.js';
import { encryptString } from '../domain/crypto.js';
import {
  PlaidClient,
  PlaidError,
  type FetchLike,
} from '../domain/plaid.js';
import { getPlaidConfig } from '../domain/settings.js';
import { fetchPlaidItemTransactions } from '../datasource/plaid.js';
import { persistBatch } from '../import/importer.js';
import { isUuid } from '../util.js';

/**
 * Phase 8.2 — Plaid routes. Every code path here is gated on
 * `getPlaidConfig()` returning non-null — i.e. PLAID_ENABLED=true AND
 * client_id / secret / env all set. The feature is invisible to
 * tenants until the super-admin turns it on.
 *
 * Routes:
 *   GET    /api/plaid/status
 *   POST   /api/plaid/link-token            (admin: starts a Link flow)
 *   POST   /api/plaid/exchange              (admin: public_token -> item)
 *   GET    /api/plaid/items                 (admin+spouse)
 *   POST   /api/plaid/items/:id/link-account (admin: map plaid_acct -> smrtcash)
 *   POST   /api/plaid/items/:id/sync         (admin+spouse)
 *   DELETE /api/plaid/items/:id              (admin: detach + stop billing)
 */

interface PlaidItemRow {
  id: string;
  plaid_item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  sync_cursor: string | null;
  status: string;
  last_sync_at: Date | null;
  last_sync_status: string;
  last_sync_error: string | null;
  last_sync_imported: number | null;
  last_sync_skipped: number | null;
  created_at: Date;
}

function sanitizeItem(row: PlaidItemRow) {
  return {
    id: row.id,
    plaid_item_id: row.plaid_item_id,
    institution_id: row.institution_id,
    institution_name: row.institution_name,
    status: row.status,
    last_sync_at: row.last_sync_at,
    last_sync_status: row.last_sync_status,
    last_sync_error: row.last_sync_error,
    last_sync_imported: row.last_sync_imported,
    last_sync_skipped: row.last_sync_skipped,
    created_at: row.created_at,
    has_cursor: row.sync_cursor !== null,
  };
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

function fetchOverride(app: FastifyInstance): FetchLike | undefined {
  return (app as unknown as { plaidFetchOverride?: FetchLike }).plaidFetchOverride;
}

export async function plaidRoutes(app: FastifyInstance): Promise<void> {
  // Public-to-tenant status endpoint. Returns enabled=false if the
  // super admin hasn't turned Plaid on (or hasn't supplied creds);
  // the web UI uses this to decide whether to render the Plaid block
  // on the Connections page.
  app.get('/api/plaid/status', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
    const cfg = await getPlaidConfig();
    return {
      enabled: cfg !== null,
      environment: cfg?.environment ?? null,
    };
  });

  app.post('/api/plaid/link-token', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    // 0.15.2: link-token starts a Plaid Link flow which will result
    // in a new plaid_items row on exchange. Gate on BANK_SYNC + cap
    // here so the user doesn't go through Link only to be refused
    // at the exchange step.
    const denyFeat = await requireFeature(tenantId, FEATURES.BANK_SYNC);
    if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
    const denySlot = await requireBankConnectionSlot(tenantId);
    if (denySlot) return reply.code(denySlot.status).send({ error: denySlot.error });
    const ctx = await loadUserContext(req.user!.id, tenantId);
    if (!canManageMembers(ctx)) {
      return reply.code(403).send({ error: 'Only tenant admins may link Plaid' });
    }
    const cfg = await getPlaidConfig();
    if (!cfg) return reply.code(400).send({ error: 'Plaid is not enabled' });

    try {
      const client = new PlaidClient({ config: cfg, fetchImpl: fetchOverride(app) });
      const r = await client.linkTokenCreate({
        userId: req.user!.id,
        clientName: 'SmrtCash',
      });
      return { link_token: r.link_token, expiration: r.expiration };
    } catch (err) {
      if (err instanceof PlaidError) {
        return reply.code(400).send({ error: err.message, kind: err.kind });
      }
      throw err;
    }
  });

  app.post<{ Body: { publicToken?: string } }>(
    '/api/plaid/exchange',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      // Same gates as link-token — exchange is the step that actually
      // creates the plaid_items row, so cap-check before the INSERT.
      const denyFeat = await requireFeature(tenantId, FEATURES.BANK_SYNC);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const denySlot = await requireBankConnectionSlot(tenantId);
      if (denySlot) return reply.code(denySlot.status).send({ error: denySlot.error });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      if (!canManageMembers(ctx)) {
        return reply.code(403).send({ error: 'Only tenant admins may link Plaid' });
      }
      const cfg = await getPlaidConfig();
      if (!cfg) return reply.code(400).send({ error: 'Plaid is not enabled' });
      const publicToken = (req.body?.publicToken ?? '').trim();
      if (!publicToken)
        return reply.code(400).send({ error: 'publicToken is required' });

      try {
        const client = new PlaidClient({ config: cfg, fetchImpl: fetchOverride(app) });
        const exch = await client.exchangePublicToken(publicToken);
        const accountsRes = await client.accountsGet(exch.access_token);

        const encrypted = encryptString(exch.access_token);
        const row = await pool.query<PlaidItemRow>(
          `INSERT INTO plaid_items
             (tenant_id, plaid_item_id, institution_id, access_token_encrypted)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, plaid_item_id) DO UPDATE
             SET access_token_encrypted = EXCLUDED.access_token_encrypted,
                 status = 'active',
                 updated_at = now()
           RETURNING *`,
          [
            tenantId,
            exch.item_id,
            accountsRes.item.institution_id,
            encrypted,
          ],
        );
        return {
          item: sanitizeItem(row.rows[0]!),
          accounts: accountsRes.accounts,
        };
      } catch (err) {
        if (err instanceof PlaidError) {
          return reply.code(400).send({ error: err.message, kind: err.kind });
        }
        throw err;
      }
    },
  );

  app.get('/api/plaid/items', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const r = await pool.query<PlaidItemRow>(
      `SELECT * FROM plaid_items WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    const links = await pool.query<{
      plaid_item_id: string;
      plaid_account_id: string;
      account_id: string;
      plaid_account_name: string | null;
      plaid_account_mask: string | null;
      plaid_account_type: string | null;
      plaid_account_subtype: string | null;
    }>(
      `SELECT plaid_item_id, plaid_account_id, account_id, plaid_account_name,
              plaid_account_mask, plaid_account_type, plaid_account_subtype
         FROM plaid_account_links
        WHERE plaid_item_id = ANY($1)`,
      [r.rows.map((row) => row.id)],
    );
    const linksByItem = new Map<string, typeof links.rows>();
    for (const l of links.rows) {
      const list = linksByItem.get(l.plaid_item_id) ?? [];
      list.push(l);
      linksByItem.set(l.plaid_item_id, list);
    }
    return {
      items: r.rows.map((row) => ({
        ...sanitizeItem(row),
        links: linksByItem.get(row.id) ?? [],
      })),
    };
  });

  app.post<{
    Params: { id: string };
    Body: {
      links?: Array<{
        plaidAccountId: string;
        accountId: string;
        plaidAccountName?: string;
        plaidAccountMask?: string;
        plaidAccountType?: string;
        plaidAccountSubtype?: string;
      }>;
    };
  }>('/api/plaid/items/:id/link-account', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const denyFeat = await requireFeature(tenantId, FEATURES.BANK_SYNC);
    if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
    if (!isUuid(req.params.id))
      return reply.code(400).send({ error: 'Invalid id' });
    const ctx = await loadUserContext(req.user!.id, tenantId);
    if (!canManageMembers(ctx)) {
      return reply.code(403).send({ error: 'Only tenant admins may link accounts' });
    }
    const item = await pool.query<{ id: string }>(
      `SELECT id FROM plaid_items WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId],
    );
    if (item.rowCount === 0)
      return reply.code(404).send({ error: 'Plaid item not found' });

    const links = req.body?.links ?? [];
    if (links.length === 0)
      return reply.code(400).send({ error: 'links[] is required' });

    for (const l of links) {
      if (!l.plaidAccountId || !isUuid(l.accountId)) {
        return reply.code(400).send({ error: 'Each link needs plaidAccountId + accountId (UUID)' });
      }
      await pool.query(
        `INSERT INTO plaid_account_links
           (plaid_item_id, plaid_account_id, account_id, plaid_account_name,
            plaid_account_mask, plaid_account_type, plaid_account_subtype)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (plaid_item_id, plaid_account_id) DO UPDATE
           SET account_id = EXCLUDED.account_id,
               plaid_account_name = EXCLUDED.plaid_account_name,
               plaid_account_mask = EXCLUDED.plaid_account_mask,
               plaid_account_type = EXCLUDED.plaid_account_type,
               plaid_account_subtype = EXCLUDED.plaid_account_subtype`,
        [
          req.params.id,
          l.plaidAccountId,
          l.accountId,
          l.plaidAccountName ?? null,
          l.plaidAccountMask ?? null,
          l.plaidAccountType ?? null,
          l.plaidAccountSubtype ?? null,
        ],
      );
    }
    return { ok: true, linkedCount: links.length };
  });

  app.post<{ Params: { id: string } }>(
    '/api/plaid/items/:id/sync',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.BANK_SYNC);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      const denied = requireFinancialMutation(ctx);
      if (denied) return reply.code(denied.status).send({ error: denied.error });
      const cfg = await getPlaidConfig();
      if (!cfg) return reply.code(400).send({ error: 'Plaid is not enabled' });

      try {
        const result = await fetchPlaidItemTransactions({
          plaidItemId: req.params.id,
          tenantId,
          fetchImpl: fetchOverride(app),
        });

        let totalImported = 0;
        let totalSkipped = 0;
        let totalErrors = result.errors.length;
        for (const [smrtAccountId, txns] of result.byAccount.entries()) {
          const persisted = await persistBatch(
            smrtAccountId,
            `plaid:${req.params.id}`,
            'plaid',
            txns,
            [],
          );
          totalImported += persisted.importedCount;
          totalSkipped += persisted.skippedCount;
          totalErrors += persisted.errorCount;
        }

        await pool.query(
          `UPDATE plaid_items
              SET sync_cursor = $1,
                  last_sync_at = now(),
                  last_sync_status = 'ok',
                  last_sync_error = NULL,
                  last_sync_imported = $2,
                  last_sync_skipped = $3,
                  updated_at = now()
            WHERE id = $4`,
          [result.cursor, totalImported, totalSkipped, req.params.id],
        );
        return {
          ok: true,
          importedCount: totalImported,
          skippedCount: totalSkipped,
          errorCount: totalErrors,
          unmappedCount: result.unmapped.length,
        };
      } catch (err) {
        const kind = err instanceof PlaidError ? err.kind : 'transport_error';
        const message = err instanceof Error ? err.message : String(err);
        await pool.query(
          `UPDATE plaid_items
              SET last_sync_status = $1,
                  last_sync_error = $2,
                  updated_at = now()
            WHERE id = $3`,
          [kind, message, req.params.id],
        );
        return reply.code(400).send({ ok: false, kind, error: message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/plaid/items/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      if (!canManageMembers(ctx)) {
        return reply.code(403).send({ error: 'Only tenant admins may delete items' });
      }
      const cfg = await getPlaidConfig();
      const item = await pool.query<{ id: string; access_token_encrypted: Buffer }>(
        `SELECT id, access_token_encrypted FROM plaid_items WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (item.rowCount === 0)
        return reply.code(404).send({ error: 'Plaid item not found' });

      // Best-effort: tell Plaid to detach the item (stops billing in
      // production). If Plaid is disabled or unreachable, we still
      // delete locally — the user wanted it gone.
      if (cfg) {
        try {
          const { decryptString } = await import('../domain/crypto.js');
          const accessToken = decryptString(item.rows[0]!.access_token_encrypted);
          const client = new PlaidClient({ config: cfg, fetchImpl: fetchOverride(app) });
          await client.itemRemove(accessToken);
        } catch {
          /* swallow — we still delete the local row */
        }
      }

      await pool.query(`DELETE FROM plaid_items WHERE id = $1`, [req.params.id]);
      return reply.code(204).send();
    },
  );
}
