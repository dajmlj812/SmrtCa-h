import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool, withTransaction } from '../db/pool.js';
import { loadUserContext, requireFinancialMutation, canManageMembers } from '../auth/rbac.js';
import {
  FEATURES,
  requireBankConnectionSlot,
  requireFeature,
} from '../auth/entitlements.js';
import {
  encryptString,
  decryptString,
  CryptoNotConfiguredError,
} from '../domain/crypto.js';
import { OfxDcError, type PostOfxOptions } from '../domain/ofx-dc.js';
import { validatePublicUrlSync } from '../util/url-safety.js';
import {
  ofxDirectConnectSource,
  type OfxDirectConnectContext,
} from '../datasource/ofx-direct-connect.js';
import { persistBatch } from '../import/importer.js';
import { isUuid } from '../util.js';

/**
 * Phase 8.1 — manage OFX Direct Connect bank connections and trigger
 * fetches. Connections are tenant-scoped. Only tenant admins manage
 * them (it carries bank credentials); spouses can fetch but not edit;
 * children are blocked entirely.
 *
 * Routes:
 *   GET    /api/ofx-dc/connections
 *   POST   /api/ofx-dc/connections
 *   PATCH  /api/ofx-dc/connections/:id
 *   DELETE /api/ofx-dc/connections/:id
 *   POST   /api/ofx-dc/connections/:id/test
 *   POST   /api/ofx-dc/connections/:id/sync
 */

interface ConnectionRow {
  id: string;
  tenant_id: string;
  account_id: string;
  name: string;
  ofx_url: string;
  ofx_org: string;
  ofx_fid: string;
  ofx_app_id: string;
  ofx_app_version: string;
  intu_bid: string | null;
  bank_acct_id: string;
  bank_acct_type: string;
  bank_id: string | null;
  enabled: boolean;
  last_sync_at: Date | null;
  last_sync_status: string;
  last_sync_error: string | null;
  last_sync_imported: number | null;
  last_sync_skipped: number | null;
  created_at: Date;
  updated_at: Date;
}

function sanitize(row: ConnectionRow) {
  // Never return encrypted credentials.
  return {
    id: row.id,
    account_id: row.account_id,
    name: row.name,
    ofx_url: row.ofx_url,
    ofx_org: row.ofx_org,
    ofx_fid: row.ofx_fid,
    ofx_app_id: row.ofx_app_id,
    ofx_app_version: row.ofx_app_version,
    intu_bid: row.intu_bid,
    bank_acct_id: row.bank_acct_id,
    bank_acct_type: row.bank_acct_type,
    bank_id: row.bank_id,
    enabled: row.enabled,
    last_sync_at: row.last_sync_at,
    last_sync_status: row.last_sync_status,
    last_sync_error: row.last_sync_error,
    last_sync_imported: row.last_sync_imported,
    last_sync_skipped: row.last_sync_skipped,
  };
}

interface ConnectionBody {
  accountId?: string;
  name?: string;
  ofxUrl?: string;
  ofxOrg?: string;
  ofxFid?: string;
  ofxAppId?: string;
  ofxAppVersion?: string;
  intuBid?: string | null;
  username?: string;
  password?: string;
  bankAcctId?: string;
  bankAcctType?: string;
  bankId?: string | null;
  enabled?: boolean;
}

const VALID_ACCT_TYPES = new Set([
  'CHECKING',
  'SAVINGS',
  'MONEYMRKT',
  'CREDITLINE',
  'CREDITCARD',
]);

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

export async function ofxDcRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ofx-dc/connections', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const r = await pool.query<ConnectionRow>(
      `SELECT * FROM ofx_dc_connections
        WHERE tenant_id = $1
        ORDER BY name ASC`,
      [tenantId],
    );
    return { connections: r.rows.map(sanitize) };
  });

  app.post<{ Body: ConnectionBody }>(
    '/api/ofx-dc/connections',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      // 0.15.2: BANK_SYNC feature + per-plan connection-cap. Order
      // matters: feature first (cleanest "needs upgrade" message);
      // slot check second (gives a specific "you're at the limit"
      // message when on a Plus/Family plan).
      const denyFeat = await requireFeature(tenantId, FEATURES.BANK_SYNC);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const denySlot = await requireBankConnectionSlot(tenantId);
      if (denySlot) return reply.code(denySlot.status).send({ error: denySlot.error });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      if (!canManageMembers(ctx)) {
        return reply
          .code(403)
          .send({ error: 'Only tenant admins may manage bank connections' });
      }

      const v = validateBody(req.body, { requireSecrets: true });
      if (typeof v === 'string') return reply.code(400).send({ error: v });

      try {
        const usernameEnc = encryptString(v.username);
        const passwordEnc = encryptString(v.password);
        const row = await pool.query<ConnectionRow>(
          `INSERT INTO ofx_dc_connections (
             tenant_id, account_id, name, ofx_url, ofx_org, ofx_fid,
             ofx_app_id, ofx_app_version, intu_bid, username_encrypted,
             password_encrypted, bank_acct_id, bank_acct_type, bank_id, enabled
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING *`,
          [
            tenantId,
            v.accountId,
            v.name,
            v.ofxUrl,
            v.ofxOrg,
            v.ofxFid,
            v.ofxAppId,
            v.ofxAppVersion,
            v.intuBid,
            usernameEnc,
            passwordEnc,
            v.bankAcctId,
            v.bankAcctType,
            v.bankId,
            v.enabled,
          ],
        );
        return reply.code(201).send({ connection: sanitize(row.rows[0]!) });
      } catch (err) {
        if (err instanceof CryptoNotConfiguredError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: ConnectionBody }>(
    '/api/ofx-dc/connections/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.BANK_SYNC);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      if (!canManageMembers(ctx)) {
        return reply
          .code(403)
          .send({ error: 'Only tenant admins may manage bank connections' });
      }
      const v = validateBody(req.body, { requireSecrets: false });
      if (typeof v === 'string') return reply.code(400).send({ error: v });

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, value: unknown) => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };
      set('name', v.name);
      set('ofx_url', v.ofxUrl);
      set('ofx_org', v.ofxOrg);
      set('ofx_fid', v.ofxFid);
      set('ofx_app_id', v.ofxAppId);
      set('ofx_app_version', v.ofxAppVersion);
      set('intu_bid', v.intuBid);
      set('bank_acct_id', v.bankAcctId);
      set('bank_acct_type', v.bankAcctType);
      set('bank_id', v.bankId);
      set('account_id', v.accountId);
      set('enabled', v.enabled);
      if (v.username !== undefined && v.username !== '') {
        set('username_encrypted', encryptString(v.username));
      }
      if (v.password !== undefined && v.password !== '') {
        set('password_encrypted', encryptString(v.password));
      }
      sets.push(`updated_at = now()`);
      params.push(req.params.id, tenantId);
      const row = await pool.query<ConnectionRow>(
        `UPDATE ofx_dc_connections
            SET ${sets.join(', ')}
          WHERE id = $${params.length - 1}
            AND tenant_id = $${params.length}
        RETURNING *`,
        params,
      );
      if (row.rowCount === 0)
        return reply.code(404).send({ error: 'Connection not found' });
      return { connection: sanitize(row.rows[0]!) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/ofx-dc/connections/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const ctx = await loadUserContext(req.user!.id, tenantId);
      if (!canManageMembers(ctx)) {
        return reply
          .code(403)
          .send({ error: 'Only tenant admins may manage bank connections' });
      }
      const r = await pool.query(
        `DELETE FROM ofx_dc_connections WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Connection not found' });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/ofx-dc/connections/:id/test',
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

      const overrides = app as unknown as {
        ofxDcFetchOverride?: PostOfxOptions['fetchImpl'];
        ofxDcSafetyOverride?: PostOfxOptions['safetyCheck'];
      };
      const fetchImpl = overrides.ofxDcFetchOverride;
      const safetyCheck = overrides.ofxDcSafetyOverride;
      try {
        // 1-day window — just probe the bank for an auth-success response.
        const end = new Date();
        const start = new Date(end);
        start.setUTCDate(start.getUTCDate() - 1);
        const result = await ofxDirectConnectSource.fetch({
          connectionId: req.params.id,
          tenantId,
          startDate: start,
          endDate: end,
          fetchImpl,
          safetyCheck,
        } as OfxDirectConnectContext);
        return {
          ok: true,
          parsedCount: result.transactions.length,
          errorCount: result.errors.length,
        };
      } catch (err) {
        if (err instanceof OfxDcError) {
          return reply
            .code(400)
            .send({ ok: false, kind: err.kind, error: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/ofx-dc/connections/:id/sync',
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

      const conn = await pool.query<ConnectionRow>(
        `SELECT * FROM ofx_dc_connections WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (conn.rowCount === 0)
        return reply.code(404).send({ error: 'Connection not found' });
      const row = conn.rows[0]!;
      if (!row.enabled)
        return reply.code(400).send({ error: 'Connection is disabled' });

      const overrides = app as unknown as {
        ofxDcFetchOverride?: PostOfxOptions['fetchImpl'];
        ofxDcSafetyOverride?: PostOfxOptions['safetyCheck'];
      };
      const fetchImpl = overrides.ofxDcFetchOverride;
      const safetyCheck = overrides.ofxDcSafetyOverride;
      const end = new Date();
      try {
        const result = await ofxDirectConnectSource.fetch({
          connectionId: row.id,
          tenantId,
          endDate: end,
          fetchImpl,
          safetyCheck,
        } as OfxDirectConnectContext);

        const persisted = await persistBatch(
          row.account_id,
          `ofx-dc:${row.name}`,
          'ofx_dc',
          result.transactions,
          result.errors,
        );
        await pool.query(
          `UPDATE ofx_dc_connections
              SET last_sync_at = $1,
                  last_sync_status = 'ok',
                  last_sync_error = NULL,
                  last_sync_imported = $2,
                  last_sync_skipped = $3,
                  updated_at = now()
            WHERE id = $4`,
          [end, persisted.importedCount, persisted.skippedCount, row.id],
        );
        return {
          ok: true,
          importedCount: persisted.importedCount,
          skippedCount: persisted.skippedCount,
          errorCount: persisted.errorCount,
        };
      } catch (err) {
        const kind = err instanceof OfxDcError ? err.kind : 'transport_error';
        const message = err instanceof Error ? err.message : String(err);
        await pool.query(
          `UPDATE ofx_dc_connections
              SET last_sync_status = $1,
                  last_sync_error = $2,
                  updated_at = now()
            WHERE id = $3`,
          [kind, message, row.id],
        );
        return reply.code(400).send({ ok: false, kind, error: message });
      }
    },
  );
}

function validateBody(
  body: ConnectionBody | undefined,
  opts: { requireSecrets: boolean },
): ConnectionBody & {
  accountId: string;
  name: string;
  ofxUrl: string;
  ofxOrg: string;
  ofxFid: string;
  ofxAppId: string;
  ofxAppVersion: string;
  intuBid: string | null;
  username: string;
  password: string;
  bankAcctId: string;
  bankAcctType:
    | 'CHECKING'
    | 'SAVINGS'
    | 'MONEYMRKT'
    | 'CREDITLINE'
    | 'CREDITCARD';
  bankId: string | null;
  enabled: boolean;
} | string {
  const b = body ?? {};
  const accountId = (b.accountId ?? '').trim();
  if (!isUuid(accountId)) return 'accountId is required and must be a UUID';
  const name = (b.name ?? '').trim();
  if (!name) return 'name is required';
  const ofxUrl = (b.ofxUrl ?? '').trim();
  if (!/^https?:\/\//.test(ofxUrl)) return 'ofxUrl must be an http(s) URL';
  // F-23 (security audit 2026-05-25) — refuse private / loopback /
  // link-local / metadata-service IPs. Without this, a paying customer
  // with BANK_SYNC could point ofxUrl at 169.254.169.254 (cloud
  // instance metadata) or 127.0.0.1:5432 (database) and trigger
  // server-initiated requests with their OFX credentials in body.
  try {
    validatePublicUrlSync(ofxUrl);
  } catch (err) {
    return err instanceof Error ? err.message : 'ofxUrl is not a safe URL';
  }
  const ofxOrg = (b.ofxOrg ?? '').trim();
  const ofxFid = (b.ofxFid ?? '').trim();
  if (!ofxOrg || !ofxFid) return 'ofxOrg and ofxFid are required';
  const bankAcctId = (b.bankAcctId ?? '').trim();
  if (!bankAcctId) return 'bankAcctId is required';
  const bankAcctType = (b.bankAcctType ?? '').trim().toUpperCase();
  if (!VALID_ACCT_TYPES.has(bankAcctType))
    return `bankAcctType must be one of: ${[...VALID_ACCT_TYPES].join(', ')}`;
  const username = (b.username ?? '').toString();
  const password = (b.password ?? '').toString();
  if (opts.requireSecrets && (username === '' || password === '')) {
    return 'username and password are required on create';
  }

  return {
    accountId,
    name,
    ofxUrl,
    ofxOrg,
    ofxFid,
    ofxAppId: (b.ofxAppId ?? 'QWIN').trim() || 'QWIN',
    ofxAppVersion: (b.ofxAppVersion ?? '2700').trim() || '2700',
    intuBid: b.intuBid ? String(b.intuBid).trim() : null,
    username,
    password,
    bankAcctId,
    bankAcctType: bankAcctType as
      | 'CHECKING'
      | 'SAVINGS'
      | 'MONEYMRKT'
      | 'CREDITLINE'
      | 'CREDITCARD',
    bankId: b.bankId ? String(b.bankId).trim() : null,
    enabled: b.enabled !== undefined ? Boolean(b.enabled) : true,
  };
}

/**
 * Mirror — tests use this to lookup decrypted credentials and assert
 * we round-trip correctly. Not exposed via HTTP.
 */
export async function _testDecryptStoredCredentials(id: string): Promise<{
  username: string;
  password: string;
} | null> {
  const r = await pool.query<{ username_encrypted: Buffer; password_encrypted: Buffer }>(
    `SELECT username_encrypted, password_encrypted FROM ofx_dc_connections WHERE id = $1`,
    [id],
  );
  if (r.rowCount === 0) return null;
  return {
    username: decryptString(r.rows[0]!.username_encrypted),
    password: decryptString(r.rows[0]!.password_encrypted),
  };
}

// Silence unused-warning when the helper above isn't imported.
void withTransaction;
