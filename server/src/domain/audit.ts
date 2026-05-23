import { query } from '../db/pool.js';

/**
 * Append-only audit log. The super-admin console reads from this; the
 * Workspace page may surface a tenant-scoped view later. Writers should
 * call `recordAudit(...)` whenever an action mutates membership /
 * provider config / tenant state.
 *
 * Failure to write the audit log is logged but never blocks the
 * originating action — `recordAudit` is a fire-and-forget wrapper.
 */

export type ActorKind = 'super_admin' | 'tenant_user' | 'system' | 'public';

export interface AuditEntry {
  tenantId?: string | null;
  actorUserId?: string | null;
  actorKind: ActorKind;
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log
         (tenant_id, actor_user_id, actor_kind, action, target_kind, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        entry.tenantId ?? null,
        entry.actorUserId ?? null,
        entry.actorKind,
        entry.action,
        entry.targetKind ?? null,
        entry.targetId ?? null,
        JSON.stringify(entry.details ?? {}),
      ],
    );
  } catch (err) {
    // Audit writes must not break the originating mutation. Surface
    // via stderr; production deployments can scrape these.
    // eslint-disable-next-line no-console
    console.error('audit log write failed:', err);
  }
}

export interface AuditQueryOpts {
  tenantId?: string | null;
  action?: string;
  limit?: number;
  before?: string;
}

export async function listAudit(opts: AuditQueryOpts = {}): Promise<
  Array<{
    id: string;
    occurred_at: string;
    tenant_id: string | null;
    actor_user_id: string | null;
    actor_kind: ActorKind;
    action: string;
    target_kind: string | null;
    target_id: string | null;
    details: Record<string, unknown>;
  }>
> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.tenantId !== undefined) {
    if (opts.tenantId === null) {
      where.push('tenant_id IS NULL');
    } else {
      params.push(opts.tenantId);
      where.push(`tenant_id = $${params.length}`);
    }
  }
  if (opts.action) {
    params.push(opts.action);
    where.push(`action = $${params.length}`);
  }
  if (opts.before) {
    params.push(opts.before);
    where.push(`occurred_at < $${params.length}`);
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  params.push(limit);
  const r = await query(
    `SELECT id, occurred_at::text, tenant_id, actor_user_id, actor_kind,
            action, target_kind, target_id, details
       FROM audit_log
       ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY occurred_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows as Array<{
    id: string;
    occurred_at: string;
    tenant_id: string | null;
    actor_user_id: string | null;
    actor_kind: ActorKind;
    action: string;
    target_kind: string | null;
    target_id: string | null;
    details: Record<string, unknown>;
  }>;
}
