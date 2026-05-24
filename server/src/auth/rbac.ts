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
 * Account scope for the current user.
 *
 *   - admin           → null (no scope, see everything)
 *   - child           → ALWAYS scoped — every child-visible account
 *                       MUST appear in account_user_access. Returning
 *                       `[]` means "no accounts assigned yet".
 *   - spouse          → 0.13.4 generalization: if the spouse has ANY
 *                       account_user_access rows for this tenant, they
 *                       are scoped to those. Zero rows = unrestricted
 *                       (preserves pre-0.13.4 behavior — spouse who
 *                       was never restricted keeps full access).
 */
export async function scopedAccountIds(
  ctx: UserContext,
): Promise<string[] | null> {
  if (!ctx.tenantId) return null;
  if (ctx.role === 'admin') return null;
  if (ctx.role !== 'child' && ctx.role !== 'spouse') return null;

  const r = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM account_user_access
      WHERE user_id = $1 AND tenant_id = $2`,
    [ctx.userId, ctx.tenantId],
  );
  const ids = r.rows.map((row) => row.account_id);
  if (ctx.role === 'spouse' && ids.length === 0) {
    // No scope rows = legacy unrestricted spouse.
    return null;
  }
  return ids;
}

/**
 * Returns true if the user can WRITE to the given account.
 *
 *   - admin           → always
 *   - spouse          → always when no access rows exist; otherwise
 *                       requires a row with permission='read_write'
 *   - child           → requires a row with permission='read_write'
 *
 * Route handlers should call this BEFORE running a mutation that
 * targets a specific account.
 */
export async function canWriteAccount(
  ctx: UserContext,
  accountId: string,
): Promise<boolean> {
  if (!ctx.tenantId) return false;
  if (ctx.role === 'admin') return true;
  if (ctx.role !== 'spouse' && ctx.role !== 'child') return false;

  if (ctx.role === 'spouse') {
    const any = await pool.query(
      `SELECT 1 FROM account_user_access
        WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
      [ctx.userId, ctx.tenantId],
    );
    if (any.rowCount === 0) return true; // unrestricted spouse
  }

  const r = await pool.query(
    `SELECT 1 FROM account_user_access
      WHERE user_id = $1 AND tenant_id = $2
        AND account_id = $3 AND permission = 'read_write' LIMIT 1`,
    [ctx.userId, ctx.tenantId, accountId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Gate a mutation that targets a specific account. Returns null when
 * the request should proceed; otherwise a `{status, error}` object the
 * route handler can send. Reads use scopedAccountIds() — this helper
 * is specifically for writes.
 */
export async function assertAccountWriteAccess(
  ctx: UserContext,
  accountId: string,
): Promise<{ status: number; error: string } | null> {
  // First the role-level financial-mutation gate (children blocked
  // outright unless they have a read_write row).
  const denied = requireFinancialMutation(ctx);
  if (denied && ctx.role !== 'child') return denied;
  if (await canWriteAccount(ctx, accountId)) return null;
  return {
    status: 403,
    error: 'You do not have write access to this account',
  };
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

/**
 * 0.14.0 — tenant gate used by every tenant-scoped route.
 *
 * Sessions without an active tenant (super-admin sessions hitting
 * tenant data; freshly-created users with no membership yet) get 403
 * instead of seeing every tenant's data. The previously-duplicated
 * `requireTenant` helper in each route file now lives here so all
 * 0.14.x slices import the same one.
 */
export function requireTenant(
  req: FastifyRequest,
  reply: FastifyReply,
): string | null {
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

/**
 * 0.14.0 — multi-tenant isolation hardening.
 *
 * The audit found that many routes accept an entity id (account_id,
 * transaction_id, holding_id) in the request body or URL and then
 * mutate without checking whether the id belongs to the caller's
 * tenant. These helpers are the cheap single-SELECT check that every
 * such route should run BEFORE the mutation:
 *
 *   const ok = await assertAccountInTenant(tenantId, accountId);
 *   if (!ok) return reply.code(404).send({ error: 'Account not found' });
 *
 * 404 (not 403) is intentional: a cross-tenant probe shouldn't be
 * able to distinguish "this id exists on another tenant" from "this
 * id doesn't exist anywhere" — the response shape is the same as a
 * truly-unknown id, which prevents id-enumeration via timing/status.
 */
export async function assertAccountInTenant(
  tenantId: string,
  accountId: string,
): Promise<boolean> {
  const r = await pool.query(
    'SELECT 1 FROM accounts WHERE id = $1 AND tenant_id = $2',
    [accountId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * A transaction belongs to a tenant via its account. Joining through
 * `accounts` keeps a single source of truth for ownership even though
 * `transactions` has no `tenant_id` column of its own.
 */
export async function assertTransactionInTenant(
  tenantId: string,
  transactionId: string,
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.id = $1 AND a.tenant_id = $2`,
    [transactionId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Holdings have their own `tenant_id` column (added in 0.13.3), but
 * we check via the account join as well to defend against rows whose
 * `holdings.tenant_id` is NULL (older rows, manual SQL inserts). One
 * extra join is cheap; the alternative is silent leakage if the
 * column is missing or wrong.
 */
export async function assertHoldingInTenant(
  tenantId: string,
  holdingId: string,
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM holdings h
       JOIN accounts a ON a.id = h.account_id
      WHERE h.id = $1 AND a.tenant_id = $2`,
    [holdingId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Categories are sometimes global (tenant_id IS NULL) and sometimes
 * per-tenant (Phase 8 added the column nullable). A reference from a
 * tenant route is valid if the category is global OR belongs to this
 * tenant. Without this check, a route that accepts `categoryId` in
 * the body lets one tenant attach another tenant's category to its
 * own transactions, leaking the category name through every query
 * that joins back to `categories`.
 */
export async function assertCategoryUsableByTenant(
  tenantId: string,
  categoryId: string,
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM categories
      WHERE id = $1 AND (tenant_id IS NULL OR tenant_id = $2)`,
    [categoryId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}
