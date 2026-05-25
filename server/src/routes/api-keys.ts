import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { generateToken } from '../auth/api-keys.js';
import { recordAudit } from '../domain/audit.js';

/**
 * 0.18.4 — self-service CRUD for the caller's own API keys.
 *
 * All three routes are user-scoped (filter on `user_id = req.user.id`)
 * so one user cannot list, mint, or revoke another user's keys —
 * even a malicious admin can only manage their own surface.
 *
 * The full token is returned EXACTLY ONCE from POST. After that
 * the UI shows only the prefix; the user must store it somewhere
 * themselves. This matches GitHub / Stripe / every other public-API
 * provider's pattern and keeps a DB leak from exposing live tokens.
 */

const KEY_COLUMNS = `id, tenant_id, key_prefix, label, scopes,
  last_used_at, last_used_ip, revoked_at, created_at`;

const MAX_KEYS_PER_USER = 10;

export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  // List the caller's keys. Never includes the full token (only
  // the prefix), so this is safe to render in the UI on every page
  // load.
  app.get('/api/me/api-keys', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
    const r = await query(
      `SELECT ${KEY_COLUMNS} FROM api_keys
        WHERE user_id = $1
        ORDER BY revoked_at NULLS FIRST, created_at DESC`,
      [req.user.id],
    );
    return { keys: r.rows };
  });

  // Mint a new key. Returns the full token EXACTLY ONCE; the
  // server stores only the hash. The new key is bound to the
  // caller's currently active tenant, so the request needs an
  // active tenant context (the user must pick one if they're
  // multi-tenant before minting).
  app.post<{ Body: { label?: string } }>(
    '/api/me/api-keys',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
      const label =
        typeof req.body?.label === 'string' ? req.body.label.trim() : '';
      if (label === '') {
        return reply.code(400).send({ error: 'label is required' });
      }
      if (label.length > 200) {
        return reply.code(400).send({ error: 'label is too long (max 200)' });
      }
      // Cap. Prevents a runaway script from minting unlimited
      // tokens, and the operator can always raise the constant if
      // someone has a legit need.
      const count = await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM api_keys
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [req.user.id],
      );
      if (Number(count.rows[0]!.n) >= MAX_KEYS_PER_USER) {
        return reply.code(400).send({
          error: `Maximum ${MAX_KEYS_PER_USER} active API keys per user. Revoke one before creating another.`,
        });
      }
      if (req.user.tenantId === null) {
        return reply
          .code(400)
          .send({ error: 'Pick an active workspace before minting an API key.' });
      }
      const { token, hash, prefix } = generateToken();
      const r = await query(
        `INSERT INTO api_keys
           (user_id, tenant_id, key_hash, key_prefix, label, scopes)
         VALUES ($1, $2, $3, $4, $5, 'read')
         RETURNING ${KEY_COLUMNS}`,
        [req.user.id, req.user.tenantId, hash, prefix, label],
      );
      await recordAudit({
        tenantId: req.user.tenantId,
        actorUserId: req.user.id,
        actorKind: 'tenant_user',
        action: 'api_key.create',
        targetKind: 'api_key',
        targetId: r.rows[0]!.id,
        details: { label, prefix },
      });
      return {
        key: r.rows[0],
        // The full token — caller MUST store this; we don't keep
        // it. The Web UI surfaces it with a one-time "Copy" button.
        token,
      };
    },
  );

  // Soft-revoke. Sets revoked_at; the row stays for audit + key-
  // history visibility but no longer authenticates.
  app.delete<{ Params: { id: string } }>(
    '/api/me/api-keys/:id',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid key id' });
      }
      const r = await query<{ id: string; tenant_id: string | null }>(
        `UPDATE api_keys
            SET revoked_at = now()
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id, tenant_id`,
        [req.params.id, req.user.id],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Key not found or already revoked' });
      }
      await recordAudit({
        tenantId: r.rows[0]!.tenant_id,
        actorUserId: req.user.id,
        actorKind: 'tenant_user',
        action: 'api_key.revoke',
        targetKind: 'api_key',
        targetId: r.rows[0]!.id,
      });
      return { revoked: true };
    },
  );
}
