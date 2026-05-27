import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { canManageMembers, loadUserContext } from '../auth/rbac.js';
import { recordAudit } from '../domain/audit.js';
import { exportTenantData, importTenantBundle } from '../domain/portability.js';

/**
 * Backlog (0.13.0) — data portability route.
 *
 * GET /api/portability/export
 *   Admin-only. Builds the per-tenant bundle, streams the tar.gz,
 *   and audits the export in audit_log. Cleanup runs after the
 *   response body is fully flushed.
 *
 * Spouses can read everything else but a full data dump is an admin
 * action — same gate as auth-provider config or member management.
 */

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

export async function portabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/portability/export', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const ctx = await loadUserContext(req.user!.id, tenantId);
    if (!canManageMembers(ctx)) {
      return reply
        .code(403)
        .send({ error: 'Only tenant admins may export tenant data' });
    }

    const result = await exportTenantData(tenantId);
    await recordAudit({
      tenantId,
      actorUserId: req.user!.id,
      actorKind: 'tenant_user',
      action: 'portability.export',
      targetKind: 'tenant',
      targetId: tenantId,
      details: { bytes: result.bytes, counts: result.counts },
    });

    reply.header('Content-Type', 'application/gzip');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${result.suggestedFilename}"`,
    );
    reply.header('Content-Length', String(result.bytes));
    // Surface row counts on a custom header so tests + curl can
    // inspect the export without parsing the tarball.
    reply.header('X-Smrtcash-Counts', JSON.stringify(result.counts));

    const stream = createReadStream(result.archivePath);
    // Schedule cleanup once the stream has been fully consumed.
    stream.on('close', () => {
      void result.cleanup();
    });
    return reply.send(stream);
  });

  // 0.21.7 — round-trip importer.
  //
  // Accepts a multipart upload of a `.smrtcash` bundle (or any
  // .tar.gz produced by the export route), rehydrates the core
  // tables into the current tenant. Tenant admin only. The user
  // should run this against an empty / new tenant — the importer
  // INSERTs without dedupe so re-running creates duplicates.
  app.post('/api/portability/import', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const ctx = await loadUserContext(req.user!.id, tenantId);
    if (!canManageMembers(ctx)) {
      return reply
        .code(403)
        .send({ error: 'Only tenant admins may import a bundle' });
    }
    const part = await req.file({ limits: { fileSize: 1024 * 1024 * 256 } });
    if (!part) {
      return reply.code(400).send({ error: 'multipart upload required' });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const stagedDir = join(tmpdir(), `smrtcash-import-stage-${stamp}`);
    await mkdir(stagedDir, { recursive: true });
    const stagedPath = join(stagedDir, 'bundle.tar.gz');
    try {
      await pipeline(part.file, createWriteStream(stagedPath));
      const result = await importTenantBundle(tenantId, stagedPath);
      await recordAudit({
        tenantId,
        actorUserId: req.user!.id,
        actorKind: 'tenant_user',
        action: 'portability.import',
        targetKind: 'tenant',
        targetId: tenantId,
        details: { imported: result.imported, source_tenant_id: result.source_tenant_id },
      });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'import failed';
      return reply.code(400).send({ error: msg });
    } finally {
      try {
        await rm(stagedDir, { recursive: true, force: true });
      } catch {
        /* tolerate */
      }
    }
  });
}
