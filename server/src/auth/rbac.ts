import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';

/**
 * Role + permission helpers. The three tenant roles plus the orthogonal
 * super_admin user flag drive every authorization check that isn't
 * already enforced by Row Level Security (RLS).
 *
 * Capabilities by role (tenant scope):
 *
 *   admin
 *     - Read + write across all accounts/transactions/budgets/bills
 *     - Manage members + invitations + role changes
 *     - Configure auth providers (owner-only operations land here)
 *     - Manage child→account assignments
 *
 *   spouse
 *     - Read + write across all financial data, same as admin
 *     - CANNOT manage members / invitations / providers
 *     - CANNOT manage child→account assignments
 *
 *   child
 *     - Sees ONLY transactions on accounts the admin assigned to them
 *     - Can edit on those (categorize, attach, split)
 *     - No visibility into other accounts, members, settings, secrets
 *
 * super_admin (orthogonal — never has a membership):
 *     - Manage tenants (create / disable / delete)
 *     - Invite / remove tenant admins (via invitations)
 *     - View system health, backups, audit log, providers
 *     - NO access to any tenant financial data — ever
 */

export type TenantRole = 'admin' | 'spouse' | 'child';

export interface UserContext {
  userId: string;
  isSuperAdmin: boolean;
  /** Current session's active tenant. null for super_admin sessions. */
  tenantId: string | null;
  /** Role in the active tenant, or null. */
  role: TenantRole | null;
}

/** Load `is_super_admin` + active-tenant role in one trip. */
export async function loadUserContext(
  userId: string,
  tenantId: string | null,
): Promise<UserContext> {
  const r = await pool.query<{ is_super_admin: boolean }>(
    `SELECT is_super_admin FROM users WHERE id = $1`,
    [userId],
  );
  const isSuperAdmin = r.rows[0]?.is_super_admin ?? false;
  let role: TenantRole | null = null;
  if (!isSuperAdmin && tenantId) {
    const mr = await pool.query<{ role: TenantRole }>(
      `SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = $2`,
      [userId, tenantId],
    );
    role = mr.rows[0]?.role ?? null;
  }
  return { userId, isSuperAdmin, tenantId, role };
}

/** Full read+write on all financial data within the active tenant. */
export function canMutateFinancials(ctx: UserContext): boolean {
  return ctx.role === 'admin' || ctx.role === 'spouse';
}

/** Manage members / invitations / auth providers. Admin-only. */
export function canManageMembers(ctx: UserContext): boolean {
  return ctx.role === 'admin';
}

/** Manage auth providers. Admin-only inside a tenant. */
export function canManageProviders(ctx: UserContext): boolean {
  return ctx.role === 'admin';
}

/**
 * Children may only see / edit data on accounts the admin assigned to
 * them. This returns the set of account ids they can touch. For
 * admins/spouses it returns null — meaning "no scope, see everything."
 */
export async function scopedAccountIds(
  ctx: UserContext,
): Promise<string[] | null> {
  if (ctx.role !== 'child' || !ctx.tenantId) return null;
  const r = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM account_user_access
      WHERE user_id = $1 AND tenant_id = $2`,
    [ctx.userId, ctx.tenantId],
  );
  return r.rows.map((row) => row.account_id);
}

/**
 * Reject a request when the user can't mutate financials. Returns
 * `null` on success or a `{status, error}` object the route handler
 * can send.
 */
export function requireFinancialMutation(
  ctx: UserContext,
): { status: number; error: string } | null {
  if (!canMutateFinancials(ctx)) {
    return ctx.role === 'child'
      ? { status: 403, error: 'Children cannot modify financial data' }
      : { status: 403, error: 'Not a member of this tenant' };
  }
  return null;
}

/**
 * Reject anything not coming from a super-admin session. Used as the
 * gate on /api/system/*, /api/health/*, /api/backups/*, and on
 * super-only setting keys (SMTP_*, BACKUP_*, SESSION_SECRET,
 * ATTACHMENT_ENCRYPTION_KEY, APP_BASE_URL). Returns true when the
 * request should proceed; otherwise sends the response and returns
 * false.
 */
export function requireSuperAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (!req.user) {
    reply.code(401).send({ error: 'Not authenticated' });
    return false;
  }
  if (!req.user.isSuperAdmin) {
    reply.code(403).send({ error: 'Super admin only' });
    return false;
  }
  return true;
}
