import { query, withTransaction } from '../db/pool.js';
import type { ProviderIdentity } from './providers/types.js';

/**
 * Find the user behind a provider identity, or create one.
 *
 * If a `user_identities` row already exists for (provider, providerUserId),
 * we return its user (update last_used_at as a side-effect).
 *
 * Otherwise: if the email matches an existing user, we LINK the new
 * identity to that user (e.g. user previously logged in via password,
 * now logs in via Google — same email collapses them). If no match,
 * we create a fresh user + identity.
 *
 * Membership is NOT created here — callers handle that explicitly when
 * accepting an invitation or claiming the first-user-becomes-owner-of-
 * Default flow.
 */

export interface ResolvedUser {
  userId: string;
  email: string | null;
  name: string | null;
  /** True when this resolve created a new users row. */
  createdUser: boolean;
}

export async function resolveIdentity(
  identity: ProviderIdentity,
): Promise<ResolvedUser> {
  // 1) Existing identity?
  const existing = await query<{
    user_id: string;
    email: string | null;
    name: string | null;
  }>(
    `SELECT u.id AS user_id, u.email, u.name
       FROM user_identities ui
       JOIN users u ON u.id = ui.user_id
      WHERE ui.provider = $1 AND ui.provider_user_id = $2`,
    [identity.provider, identity.providerUserId],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    const row = existing.rows[0]!;
    await query(
      `UPDATE user_identities SET last_used_at = now()
        WHERE provider = $1 AND provider_user_id = $2`,
      [identity.provider, identity.providerUserId],
    );
    return {
      userId: row.user_id,
      email: row.email,
      name: row.name,
      createdUser: false,
    };
  }

  // 2) Email match? Link identity to existing user.
  //
  // F-20 (security audit 2026-05-25) — the auto-link is gated on the
  // provider asserting that the email has been verified at its end.
  // Without this gate, an attacker who controls (or finds a
  // misconfigured) OIDC provider that allows users to set arbitrary
  // unverified emails could claim `victim@example.com` and be
  // logged in as the existing local user with that email. The
  // `local` provider sets emailVerified=true after the
  // /api/auth/verify-email loop; OIDC reads it from the
  // `email_verified` claim (defaulting to false). SAML or any future
  // provider must set it deliberately.
  if (identity.email && identity.emailVerified === true) {
    const byEmail = await query<{
      id: string;
      email: string | null;
      name: string | null;
    }>(
      `SELECT id, email, name FROM users
        WHERE lower(email) = lower($1) LIMIT 1`,
      [identity.email],
    );
    if (byEmail.rowCount && byEmail.rowCount > 0) {
      const user = byEmail.rows[0]!;
      await query(
        `INSERT INTO user_identities
           (user_id, provider, provider_user_id, email, display_name, last_used_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [
          user.id,
          identity.provider,
          identity.providerUserId,
          identity.email,
          identity.displayName ?? null,
        ],
      );
      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        createdUser: false,
      };
    }
  }

  // 3) Fresh user + identity in one transaction.
  return withTransaction(async (client) => {
    // 0.17.3 — OIDC / SAML identity providers verify the user's email
    // before issuing tokens; we inherit that proof. Set
    // email_verified_at on create so the 0.16.0 login gate doesn't
    // block first-login. Local-password signups still go through the
    // /api/auth/signup → /api/auth/verify-email dance.
    const verifyAtCreate = identity.provider !== 'local';
    const u = await client.query<{ id: string }>(
      `INSERT INTO users (email, name, email_verified_at)
       VALUES ($1, $2, ${verifyAtCreate ? 'now()' : 'NULL'})
       RETURNING id`,
      [identity.email ?? null, identity.displayName ?? null],
    );
    const userId = u.rows[0]!.id;
    await client.query(
      `INSERT INTO user_identities
         (user_id, provider, provider_user_id, email, display_name, last_used_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [
        userId,
        identity.provider,
        identity.providerUserId,
        identity.email ?? null,
        identity.displayName ?? null,
      ],
    );
    return {
      userId,
      email: identity.email ?? null,
      name: identity.displayName ?? null,
      createdUser: true,
    };
  });
}
