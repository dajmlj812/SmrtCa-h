import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { clearProviderCache } from '../auth/providers/registry.js';
import { PRESET_OIDC } from '../auth/providers/oidc.js';
import { requireSuperAdmin } from '../auth/rbac.js';

/**
 *   GET    /api/auth-provider-configs            — list configs
 *   POST   /api/auth-provider-configs            — create
 *   PATCH  /api/auth-provider-configs/:id        — update enabled/config
 *   DELETE /api/auth-provider-configs/:id        — remove
 *
 * Super-admin only (0.9.2). Auth providers determine who can sign in
 * to the entire platform; that's a platform-operator decision, not a
 * per-tenant one. Tenant admins manage who joins THEIR tenant via
 * invitations; super admins choose which login methods exist.
 *
 * NOTE: client_secret is stored in clear text in jsonb. That mirrors
 * the rest of the secret storage in this app (ANTHROPIC_API_KEY etc.).
 * Future hardening can encrypt jsonb at rest with the existing
 * ATTACHMENT_ENCRYPTION_KEY.
 */

const ALLOWED_KINDS = ['oidc', 'saml'] as const;
type Kind = (typeof ALLOWED_KINDS)[number];

export async function authProviderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth-provider-configs', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const r = await query<{
      id: string;
      kind: string;
      slug: string;
      display_name: string;
      enabled: boolean;
      config_json: Record<string, unknown>;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, kind, slug, display_name, enabled, config_json,
              created_at::text, updated_at::text
         FROM auth_provider_configs
        ORDER BY created_at`,
    );
    const masked = r.rows.map((row) => ({
      ...row,
      config_json: maskSecrets(row.config_json),
    }));
    return { providers: masked, presets: Object.values(PRESET_OIDC) };
  });

  app.post('/api/auth-provider-configs', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const body = (req.body ?? {}) as {
      kind?: unknown;
      slug?: unknown;
      displayName?: unknown;
      enabled?: unknown;
      config?: unknown;
    };
    const kind = body.kind as Kind;
    if (!ALLOWED_KINDS.includes(kind)) {
      return reply.code(400).send({ error: 'kind must be oidc or saml' });
    }
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(slug)) {
      return reply.code(400).send({ error: 'slug must be lowercase alphanumeric (dashes/underscores ok)' });
    }
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim() !== ''
        ? body.displayName.trim()
        : slug;
    const cfg = (body.config ?? {}) as Record<string, unknown>;
    try {
      const r = await query<{ id: string }>(
        `INSERT INTO auth_provider_configs
           (kind, slug, display_name, enabled, config_json)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id`,
        [kind, slug, displayName, Boolean(body.enabled), JSON.stringify(cfg)],
      );
      clearProviderCache();
      return reply.code(201).send({ id: r.rows[0]!.id });
    } catch (err) {
      if (err instanceof Error && /duplicate key/i.test(err.message)) {
        return reply.code(409).send({ error: `Slug "${slug}" already in use` });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/api/auth-provider-configs/:id',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const body = (req.body ?? {}) as {
        displayName?: unknown;
        enabled?: unknown;
        config?: unknown;
      };
      const sets: string[] = [];
      const params: unknown[] = [];
      if (typeof body.displayName === 'string' && body.displayName.trim() !== '') {
        params.push(body.displayName.trim());
        sets.push(`display_name = $${params.length}`);
      }
      if (body.enabled !== undefined) {
        params.push(Boolean(body.enabled));
        sets.push(`enabled = $${params.length}`);
      }
      if (body.config !== undefined && typeof body.config === 'object' && body.config !== null) {
        params.push(JSON.stringify(body.config));
        sets.push(`config_json = $${params.length}::jsonb`);
      }
      if (sets.length === 0) {
        return reply.code(400).send({ error: 'No fields to update' });
      }
      sets.push(`updated_at = now()`);
      params.push(req.params.id);
      const r = await query(
        `UPDATE auth_provider_configs SET ${sets.join(', ')}
          WHERE id = $${params.length}
        RETURNING id`,
        params,
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Not found' });
      clearProviderCache();
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/auth-provider-configs/:id',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid id' });
      const r = await query(
        `DELETE FROM auth_provider_configs WHERE id = $1`,
        [req.params.id],
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Not found' });
      clearProviderCache();
      return reply.code(204).send();
    },
  );
}

function maskSecrets(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  for (const k of Object.keys(out)) {
    if (/secret|client_secret/i.test(k) && typeof out[k] === 'string') {
      const s = out[k] as string;
      out[k] = s.length <= 4 ? '••••' : '••••' + s.slice(-4);
    }
  }
  return out;
}
