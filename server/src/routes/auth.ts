import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { pool, query, withTransaction } from '../db/pool.js';
import {
  PasswordPolicyError,
  hashPassword,
  validatePassword,
} from '../auth/passwords.js';
import {
  SESSION_COOKIE,
  createSession,
  deleteAllSessionsForUser,
  deleteSession,
  pruneExpiredSessions,
} from '../auth/sessions.js';
import {
  clearProviderCache,
  getProvider,
  listProviders,
} from '../auth/providers/registry.js';
import { resolveIdentity } from '../auth/identities.js';
import { recordAudit } from '../domain/audit.js';
import {
  renderPasswordResetEmail,
  renderVerificationEmail,
  tryMail,
} from '../domain/mailer.js';
import { getEffectiveValue } from '../domain/settings.js';

const OIDC_STATE_COOKIE = 'smrtcash_oidc_state';

function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.auth.cookieSecure,
    path: '/',
    signed: true,
    expires: expiresAt,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

async function activeTenantForUser(userId: string): Promise<string | null> {
  // Pick the user's first membership (by created_at). Used when minting
  // a brand-new session.
  const r = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM memberships
      WHERE user_id = $1
      ORDER BY created_at LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.tenant_id ?? null;
}

async function isInstanceSetup(): Promise<boolean> {
  const r = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM users`,
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

/**
 * 0.16.0 — public signup gate. PUBLIC_SIGNUP_ENABLED=true is
 * required for /api/auth/signup to function. Default off so
 * existing self-host deployments don't accept random signups
 * just by upgrading; SaaS operators set this in production.
 *
 * 0.16.3 — reads via getEffectiveValue so the toggle can be
 * flipped from /settings in addition to the env var.
 */
async function publicSignupEnabled(): Promise<boolean> {
  const v = (await getEffectiveValue('PUBLIC_SIGNUP_ENABLED')).trim().toLowerCase();
  return v === 'true';
}

/**
 * 0.16.0 — verification tokens. URL-safe base64 of 32 random
 * bytes; collisions are astronomical and the column is UNIQUE
 * so a clash would just throw, not corrupt anything.
 */
function newVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

const VERIFICATION_TTL_HOURS = 24;
/**
 * 0.16.2 — password-reset token TTL. Tighter than the 24h
 * verification TTL because resets are higher-risk: a stolen
 * link is a full account takeover. One hour matches industry
 * defaults (Stripe, GitHub) and is long enough for a user to
 * click through email but short enough to limit blast radius.
 */
const PASSWORD_RESET_TTL_MINUTES = 60;

/**
 * 0.16.3 — base URL for outgoing email links (verification,
 * reset) and Stripe Checkout success/cancel. Sourced through
 * getEffectiveValue so the operator can change it from
 * /settings without touching the env file. Falls back to the
 * dev default when nothing is configured.
 */
async function publicBaseUrl(): Promise<string> {
  const v = (await getEffectiveValue('STRIPE_PUBLIC_BASE_URL')).trim();
  return (v || 'http://localhost:4000').replace(/\/+$/, '');
}

/**
 * 0.16.0 — generate a tenant slug for a new signup. Format:
 * `t-<8 url-safe random chars>`. We don't derive from the email
 * (PII leakage) or display name (collisions + Unicode mess); a
 * random slug is fine because tenants don't have public URLs.
 * The display name on the tenant gets the human-friendly text.
 */
function newTenantSlug(): string {
  return `t-${randomBytes(6).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
}

/**
 * 0.16.0 — send the verification email. When SMTP isn't
 * configured we log the link so the operator can hand it to the
 * user manually (the same fallback the invitation flow uses).
 * We never throw — the signup endpoint always reports
 * `verification_sent` to avoid leaking SMTP configuration to
 * the public.
 */
async function sendVerificationEmail(
  req: { log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void } },
  email: string,
  token: string,
  expiresAt: Date,
): Promise<void> {
  const verifyUrl = `${await publicBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  const rendered = renderVerificationEmail({
    verifyUrl,
    expiresAt: expiresAt.toISOString(),
  });
  try {
    const r = await tryMail({ to: email, ...rendered });
    if (!r.sent) {
      req.log.warn(
        { reason: r.reason, verifyUrl },
        'Signup verification email NOT sent (SMTP unconfigured); operator must hand the link to the user manually',
      );
    }
  } catch (err) {
    req.log.warn({ err, verifyUrl }, 'Verification email send failed');
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public — what the login page needs to render.
  app.get('/api/auth/status', async (req) => {
    const setup = await isInstanceSetup();
    return {
      isSetup: setup,
      authenticated: req.user !== undefined,
      // 0.16.0 — drives whether the LoginPage shows a "Create
      // an account" link. Default false; SaaS operators flip on.
      signupEnabled: await publicSignupEnabled(),
      // 0.16.3 — surface the support / feature-request URL so
      // unauthenticated pages (login/signup/forgot) can render
      // it. Default points at the BITS hosted support portal;
      // operators can repoint via /settings.
      supportUrl: (await getEffectiveValue('SUPPORT_URL')).trim() || null,
    };
  });

  // Lists enabled providers (Local always; OIDC/SAML depending on
  // auth_provider_configs). Public.
  app.get('/api/auth/providers', async () => {
    const providers = await listProviders();
    return {
      providers: providers.map((p) => ({
        id: p.id,
        kind: p.kind,
        displayName: p.displayName,
        enabled: p.enabled,
      })),
    };
  });

  // First-boot bootstrap: creates the first user as owner of the
  // already-seeded Default tenant. Refuses once any user exists.
  app.post('/api/auth/setup', async (req, reply) => {
    if (await isInstanceSetup()) {
      return reply.code(409).send({ error: 'Already initialized' });
    }
    const body = (req.body ?? {}) as {
      email?: unknown;
      name?: unknown;
      password?: unknown;
    };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (email === '') {
      return reply.code(400).send({ error: 'Email is required' });
    }
    try {
      validatePassword(body.password);
    } catch (err) {
      if (err instanceof PasswordPolicyError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    const hash = await hashPassword(body.password as string);

    // Phase 9: first user on a fresh install is a super_admin. They
    // are NOT a tenant member — managing tenants is their job; they'll
    // create tenants + invite tenant admins from /system. Existing
    // upgrades keep their tenant_admin role unchanged via the
    // migration.
    const result = await withTransaction(async (client) => {
      // 0.16.0 — the bootstrap operator never goes through the
      // email-verification flow. They're auto-verified at creation
      // so /api/auth/login accepts them without a "confirm your
      // email" detour.
      const u = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO users (email, name, password_hash, is_super_admin, email_verified_at)
         VALUES ($1, $2, $3, true, now())
         RETURNING id, created_at`,
        [email, name || 'Operator', hash],
      );
      const userId = u.rows[0]!.id;
      await client.query(
        `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
         VALUES ($1, 'local', $2, $3)`,
        [userId, userId, email],
      );
      return { userId, createdAt: u.rows[0]!.created_at };
    });

    const session = await createSession(result.userId, null);
    setSessionCookie(reply, session.id, session.expiresAt);
    await recordAudit({
      actorUserId: result.userId,
      actorKind: 'super_admin',
      action: 'super_admin.bootstrap',
      details: { email },
    });
    return reply.code(201).send({
      user: {
        id: result.userId,
        email,
        name,
        created_at: result.createdAt,
        is_super_admin: true,
      },
    });
  });

  // ── 0.16.0: public signup ─────────────────────────────────
  //
  // Creates an unverified user + verification token, emails the
  // token, and returns 202. The user clicks the verification link
  // which lands on /verify-email?token=... → POST
  // /api/auth/verify-email, which completes the dance: marks the
  // email verified, provisions a tenant + tenant_admin membership,
  // signs the user in. They then land on /billing to pick a plan.
  //
  // Gated by PUBLIC_SIGNUP_ENABLED. When the gate is off the
  // endpoint 404s so an unconfigured deployment doesn't even
  // advertise its existence to scanners.
  app.post('/api/auth/signup', async (req, reply) => {
    if (!(await publicSignupEnabled())) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const body = (req.body ?? {}) as {
      email?: unknown;
      name?: unknown;
      password?: unknown;
    };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (email === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: 'A valid email address is required' });
    }
    try {
      validatePassword(body.password);
    } catch (err) {
      if (err instanceof PasswordPolicyError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    // Idempotency by email: if the address is already in use (verified
    // or not) we return 202 with a generic "check your email" — same
    // as a fresh signup. That prevents account-enumeration via the
    // signup endpoint (an attacker can't distinguish "exists" from
    // "doesn't exist"). For an unverified existing user we DO mint
    // a fresh token so the legitimate owner can recover from a
    // dropped first email.
    const existing = await pool.query<{
      id: string;
      email_verified_at: string | null;
    }>(
      `SELECT id, email_verified_at::text AS email_verified_at
         FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      const row = existing.rows[0]!;
      if (row.email_verified_at !== null) {
        // Verified account already exists; never reveal that.
        return reply.code(202).send({ status: 'verification_sent' });
      }
      // Unverified existing user → re-mint a token.
      const token = newVerificationToken();
      const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 3_600_000);
      await pool.query(
        `INSERT INTO email_verifications (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [row.id, token, expiresAt],
      );
      await sendVerificationEmail(req, email, token, expiresAt);
      return reply.code(202).send({ status: 'verification_sent' });
    }

    const hash = await hashPassword(body.password as string);
    const token = newVerificationToken();
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 3_600_000);

    await withTransaction(async (client) => {
      // Unverified user — email_verified_at stays NULL until
      // /api/auth/verify-email runs. No tenant yet; that's
      // provisioned at verify time so abandoned signups don't
      // leave orphan tenants laying around.
      const u = await client.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, is_super_admin)
         VALUES ($1, $2, $3, false)
         RETURNING id`,
        [email, name || email.split('@')[0]!, hash],
      );
      const userId = u.rows[0]!.id;
      await client.query(
        `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
         VALUES ($1, 'local', $2, $3)`,
        [userId, userId, email],
      );
      await client.query(
        `INSERT INTO email_verifications (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, token, expiresAt],
      );
    });

    await sendVerificationEmail(req, email, token, expiresAt);
    return reply.code(202).send({ status: 'verification_sent' });
  });

  // ── 0.16.0: verify the email + provision tenant ───────────
  app.post('/api/auth/verify-email', async (req, reply) => {
    if (!(await publicSignupEnabled())) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const body = (req.body ?? {}) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    if (token === '') {
      return reply.code(400).send({ error: 'Token is required' });
    }

    const tokenRow = await pool.query<{
      id: string;
      user_id: string;
      expires_at: string;
      consumed_at: string | null;
    }>(
      `SELECT id, user_id, expires_at::text AS expires_at,
              consumed_at::text AS consumed_at
         FROM email_verifications
        WHERE token = $1`,
      [token],
    );
    if (tokenRow.rowCount === 0) {
      return reply.code(400).send({ error: 'Invalid verification token' });
    }
    const row = tokenRow.rows[0]!;
    if (row.consumed_at !== null) {
      return reply.code(400).send({ error: 'This verification link has already been used' });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return reply.code(400).send({ error: 'This verification link has expired — sign up again' });
    }

    const result = await withTransaction(async (client) => {
      // Mark verified.
      const userRow = await client.query<{ email: string | null; name: string | null }>(
        `UPDATE users SET email_verified_at = now()
          WHERE id = $1 AND email_verified_at IS NULL
          RETURNING email, name`,
        [row.user_id],
      );
      // Either the user is now verified (first hit) or was already
      // verified by a parallel request — both paths converge to
      // "make sure they have a tenant + membership and sign them in".
      const u =
        userRow.rowCount && userRow.rowCount > 0
          ? userRow.rows[0]!
          : (
              await client.query<{ email: string | null; name: string | null }>(
                `SELECT email, name FROM users WHERE id = $1`,
                [row.user_id],
              )
            ).rows[0]!;

      // Provision tenant only if the user doesn't already have one.
      // This makes verify-email idempotent even after a partial
      // failure on a previous attempt.
      const memb = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM memberships WHERE user_id = $1 LIMIT 1`,
        [row.user_id],
      );
      let tenantId: string;
      if (memb.rowCount && memb.rowCount > 0) {
        tenantId = memb.rows[0]!.tenant_id;
      } else {
        // Tenant display name: prefer the user's display name,
        // fall back to the email local-part. Slug is always random.
        const displayName =
          (u.name && u.name.trim() !== '' ? u.name.trim() : (u.email ?? 'household').split('@')[0]!) +
          "'s household";
        const slug = newTenantSlug();
        const t = await client.query<{ id: string }>(
          `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
          [displayName, slug],
        );
        tenantId = t.rows[0]!.id;
        await client.query(
          `INSERT INTO memberships (tenant_id, user_id, role)
           VALUES ($1, $2, 'admin')`,
          [tenantId, row.user_id],
        );
      }

      await client.query(
        `UPDATE email_verifications SET consumed_at = now() WHERE id = $1`,
        [row.id],
      );

      return { tenantId, userEmail: u.email ?? '', userName: u.name ?? '' };
    });

    const session = await createSession(row.user_id, result.tenantId);
    setSessionCookie(reply, session.id, session.expiresAt);
    void recordAudit({
      tenantId: result.tenantId,
      actorUserId: row.user_id,
      actorKind: 'tenant_user',
      action: 'user.signup_verified',
    });
    return {
      user: {
        id: row.user_id,
        email: result.userEmail,
        name: result.userName,
        is_super_admin: false,
      },
      tenantId: result.tenantId,
    };
  });

  // ── 0.16.2: password reset — request a link ───────────────
  //
  // Public. Takes { email }. Always returns 202 — we don't
  // reveal whether the address is registered. When the address
  // DOES match a real user we mint a token and send it via email
  // (or log it for the operator when SMTP is unconfigured —
  // same fallback as the signup verification flow). Available
  // regardless of PUBLIC_SIGNUP_ENABLED: existing users on a
  // self-host deployment still need a way to recover their own
  // password.
  app.post('/api/auth/password-reset-request', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      // Even with a malformed address we 202 to keep the enumeration
      // surface flat (a 400 here distinguishes "not a real email" from
      // "real email, doesn't match a user").
      return reply.code(202).send({ status: 'reset_sent' });
    }

    const u = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    if (u.rowCount && u.rowCount > 0) {
      const userId = u.rows[0]!.id;
      const token = newVerificationToken(); // same generator; opaque url-safe random
      const expiresAt = new Date(
        Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000,
      );
      await pool.query(
        `INSERT INTO password_resets (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, token, expiresAt],
      );
      // Best-effort email; failures don't change the response.
      const resetUrl = `${await publicBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
      const rendered = renderPasswordResetEmail({
        resetUrl,
        expiresAt: expiresAt.toISOString(),
      });
      try {
        const r = await tryMail({ to: email, ...rendered });
        if (!r.sent) {
          req.log.warn(
            { reason: r.reason, resetUrl },
            'Password reset email NOT sent (SMTP unconfigured); operator must hand the link to the user manually',
          );
        }
      } catch (err) {
        req.log.warn({ err, resetUrl }, 'Password reset email send failed');
      }
      // Audit the request itself (not the consumption) so an
      // operator can spot brute-force enumeration attempts.
      await recordAudit({
        actorUserId: userId,
        actorKind: 'tenant_user',
        action: 'user.password_reset_requested',
      });
    }
    return reply.code(202).send({ status: 'reset_sent' });
  });

  // ── 0.16.2: password reset — confirm + set new password ────
  //
  // Public. Consumes the token, validates the new password
  // against the same policy as signup, swaps in the hash, and
  // invalidates every other session for the user. Caller is NOT
  // signed in by this endpoint — they go through the login flow
  // after reset, which gives them a fresh session bound to the
  // new password.
  app.post('/api/auth/password-reset-confirm', async (req, reply) => {
    const body = (req.body ?? {}) as {
      token?: unknown;
      password?: unknown;
    };
    const token = typeof body.token === 'string' ? body.token : '';
    if (token === '') {
      return reply.code(400).send({ error: 'Token is required' });
    }
    try {
      validatePassword(body.password);
    } catch (err) {
      if (err instanceof PasswordPolicyError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    const tokenRow = await pool.query<{
      id: string;
      user_id: string;
      expires_at: string;
      consumed_at: string | null;
    }>(
      `SELECT id, user_id, expires_at::text AS expires_at,
              consumed_at::text AS consumed_at
         FROM password_resets WHERE token = $1`,
      [token],
    );
    if (tokenRow.rowCount === 0) {
      return reply.code(400).send({ error: 'Invalid reset token' });
    }
    const row = tokenRow.rows[0]!;
    if (row.consumed_at !== null) {
      return reply.code(400).send({ error: 'This reset link has already been used' });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return reply.code(400).send({ error: 'This reset link has expired — request a new one' });
    }

    const hash = await hashPassword(body.password as string);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE users SET password_hash = $1 WHERE id = $2`,
        [hash, row.user_id],
      );
      await client.query(
        `UPDATE password_resets SET consumed_at = now() WHERE id = $1`,
        [row.id],
      );
    });
    // Kill every other browser session for this user. Defense
    // against an attacker who had stolen credentials — the moment
    // the real owner resets, the attacker's session dies.
    const killed = await deleteAllSessionsForUser(row.user_id);
    await recordAudit({
      actorUserId: row.user_id,
      actorKind: 'tenant_user',
      action: 'user.password_reset_completed',
      details: { sessions_invalidated: killed },
    });
    return reply.send({ reset: true });
  });

  // Local password login. The frontend sends { email, password }. The
  // legacy single-user form (password only) is still accepted for the
  // first migration cycle — it picks the singleton user when there's
  // exactly one.
  app.post('/api/auth/login', async (req, reply) => {
    if (!(await isInstanceSetup())) {
      return reply.code(409).send({ error: 'Not initialized' });
    }
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const local = await getProvider('local');
    if (!local || !local.verify) {
      return reply.code(500).send({ error: 'Local provider unavailable' });
    }

    // Back-compat: if no email is supplied and there's exactly one user,
    // act on that user. Drop in a future cleanup once everyone has migrated.
    let email = typeof body.email === 'string' ? body.email.trim() : '';
    if (email === '') {
      const sole = await pool.query<{ email: string | null; n: number }>(
        `SELECT email, COUNT(*) OVER ()::int AS n FROM users LIMIT 1`,
      );
      if (sole.rowCount === 1 && sole.rows[0]!.n === 1 && sole.rows[0]!.email) {
        email = sole.rows[0]!.email;
      }
    }
    if (email === '') {
      return reply.code(400).send({ error: 'Email is required' });
    }

    let identity;
    try {
      identity = await local.verify({ email, password: body.password });
    } catch (err) {
      return reply
        .code(401)
        .send({ error: err instanceof Error ? err.message : 'Login failed' });
    }
    const resolved = await resolveIdentity(identity);
    // Super admins have no memberships by design — that's fine; they
    // land on /system. Tenant users need at least one membership.
    const userRow = await pool.query<{
      is_super_admin: boolean;
      email_verified_at: string | null;
    }>(
      `SELECT is_super_admin, email_verified_at::text AS email_verified_at
         FROM users WHERE id = $1`,
      [resolved.userId],
    );
    const isSuperAdmin = userRow.rows[0]?.is_super_admin ?? false;
    // 0.16.0 — public-signup users must confirm their email before
    // login is allowed. Super admins (created via /api/auth/setup
    // or upgraded from pre-031 deployments) are auto-verified by
    // the migration's UPDATE.
    if (userRow.rows[0]?.email_verified_at === null) {
      return reply.code(403).send({
        error: 'Please confirm your email address before logging in. Check your inbox for the verification link.',
      });
    }
    let tenantId: string | null = null;
    if (!isSuperAdmin) {
      tenantId = await activeTenantForUser(resolved.userId);
      if (!tenantId) {
        return reply.code(403).send({
          error: 'No tenant membership for this user',
        });
      }
    }
    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [
      resolved.userId,
    ]);
    void pruneExpiredSessions().catch((err) =>
      req.log.warn({ err }, 'Session cleanup failed'),
    );
    const session = await createSession(resolved.userId, tenantId);
    setSessionCookie(reply, session.id, session.expiresAt);
    void recordAudit({
      tenantId,
      actorUserId: resolved.userId,
      actorKind: isSuperAdmin ? 'super_admin' : 'tenant_user',
      action: isSuperAdmin ? 'super_admin.login' : 'user.login',
    });
    return {
      user: {
        id: resolved.userId,
        email: resolved.email,
        name: resolved.name,
        is_super_admin: isSuperAdmin,
      },
    };
  });

  // ── OIDC: begin + callback ───────────────────────────────
  app.get<{ Params: { slug: string }; Querystring: { returnTo?: string } }>(
    '/api/auth/oidc/:slug/begin',
    async (req, reply) => {
      const provider = await getProvider(`oidc:${req.params.slug}`);
      if (!provider) {
        return reply.code(404).send({ error: 'Unknown provider' });
      }
      const result = await provider.begin({ returnTo: req.query.returnTo });
      if (result.kind !== 'redirect') {
        return reply.code(500).send({ error: 'Provider did not start a redirect flow' });
      }
      // Stash the per-attempt state in a short-lived signed cookie so
      // the callback can verify it. Cookie name includes the slug so
      // simultaneous attempts to different IdPs don't trample each other.
      reply.setCookie(
        `${OIDC_STATE_COOKIE}_${req.params.slug}`,
        JSON.stringify(result.state),
        {
          httpOnly: true,
          sameSite: 'lax', // 'lax' so the cookie survives the IdP redirect
          secure: config.auth.cookieSecure,
          path: '/',
          signed: true,
          maxAge: 600, // 10 minutes
        },
      );
      return reply.redirect(result.url);
    },
  );

  app.get<{
    Params: { slug: string };
    Querystring: Record<string, string>;
  }>('/api/auth/oidc/:slug/callback', async (req, reply) => {
    const provider = await getProvider(`oidc:${req.params.slug}`);
    if (!provider || !provider.completeRedirect) {
      return reply.code(404).send({ error: 'Unknown provider' });
    }
    const cookieName = `${OIDC_STATE_COOKIE}_${req.params.slug}`;
    const rawCookie = req.cookies[cookieName];
    if (!rawCookie) {
      return reply.code(400).send({ error: 'OIDC state cookie missing — expired or third-party blocked' });
    }
    const unsigned = req.unsignCookie(rawCookie);
    if (!unsigned.valid || !unsigned.value) {
      return reply.code(400).send({ error: 'OIDC state cookie invalid' });
    }
    reply.clearCookie(cookieName, { path: '/' });

    let state: Record<string, string>;
    try {
      state = JSON.parse(unsigned.value) as Record<string, string>;
    } catch {
      return reply.code(400).send({ error: 'OIDC state cookie unparseable' });
    }

    let identity;
    try {
      identity = await provider.completeRedirect(req.query, state);
    } catch (err) {
      return reply.code(401).send({
        error: err instanceof Error ? err.message : 'OIDC callback failed',
      });
    }
    const resolved = await resolveIdentity(identity);
    const tenantId = await activeTenantForUser(resolved.userId);
    if (!tenantId) {
      return reply.code(403).send({
        error:
          "This account isn't a member of any tenant. Ask an admin for an invitation.",
      });
    }
    const session = await createSession(resolved.userId, tenantId);
    setSessionCookie(reply, session.id, session.expiresAt);

    // Return the user to where they came from (sanitized).
    const returnTo =
      typeof state.returnTo === 'string' && state.returnTo.startsWith('/')
        ? state.returnTo
        : '/';
    return reply.redirect(returnTo);
  });

  // Settings UI hook: rebuild the registry after a config change.
  app.post('/api/auth/providers/reload', async () => {
    clearProviderCache();
    return { ok: true };
  });

  // Logout — idempotent.
  app.post('/api/auth/logout', async (req, reply) => {
    const cookieValue = req.cookies[SESSION_COOKIE];
    if (cookieValue) {
      const unsigned = req.unsignCookie(cookieValue);
      if (unsigned.valid && unsigned.value) {
        await deleteSession(unsigned.value);
      }
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }
    const u = await query<{
      id: string;
      email: string | null;
      name: string | null;
      created_at: string;
      last_login_at: string | null;
      is_super_admin: boolean;
    }>(
      `SELECT id, email, name, created_at::text, last_login_at::text,
              is_super_admin
         FROM users WHERE id = $1`,
      [req.user.id],
    );
    if (u.rowCount === 0) {
      return reply.code(401).send({ error: 'User not found' });
    }
    const memberships = await query<{
      tenant_id: string;
      tenant_name: string;
      tenant_slug: string;
      role: string;
    }>(
      `SELECT m.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, m.role
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1
        ORDER BY m.created_at`,
      [req.user.id],
    );
    return {
      user: u.rows[0],
      memberships: memberships.rows,
      active_tenant_id: req.user.tenantId ?? null,
    };
  });
}

// Helper used by membership / invite routes to mint a fresh random token.
export function randomToken(): string {
  return randomBytes(24).toString('base64url');
}
