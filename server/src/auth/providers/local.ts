import { query } from '../../db/pool.js';
import { verifyPassword, dummyVerifyForTiming } from '../passwords.js';
import type {
  AuthProvider,
  BeginResult,
  ProviderDescriptor,
  ProviderIdentity,
} from './types.js';

/**
 * Local password provider. Wraps the existing argon2id flow so the
 * rest of the auth pipeline (identity creation, session minting) can
 * treat it identically to OIDC/SAML.
 *
 * `verify({ email, password })` looks up the user by email
 * (case-insensitive) and returns the identity on success. The
 * `provider_user_id` for local identities is the user's UUID — there's
 * no external id to bind against.
 */

export class LocalAuthProvider implements AuthProvider {
  descriptor(): ProviderDescriptor {
    return {
      id: 'local',
      kind: 'local',
      displayName: 'Email + password',
      // Local is always available — it's the bootstrap path.
      enabled: true,
    };
  }

  async begin(): Promise<BeginResult> {
    return { kind: 'credential' };
  }

  async verify(payload: Record<string, unknown>): Promise<ProviderIdentity> {
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    const password = typeof payload.password === 'string' ? payload.password : '';
    if (email === '' || password === '') {
      throw new Error('Email and password are required');
    }
    const r = await query<{
      id: string;
      password_hash: string;
      email: string | null;
      name: string | null;
    }>(
      `SELECT id, password_hash, email, name
         FROM users
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email],
    );
    if (r.rowCount === 0) {
      // F-06 (security audit 2026-05-25) — burn the same CPU cycles
      // we WOULD have burned on argon2.verify if the user existed.
      // Without this, login response time differs by ~30ms between
      // "existing user, wrong password" and "no such user", which
      // is enough signal to enumerate the user table.
      await dummyVerifyForTiming();
      throw new Error('Invalid email or password');
    }
    const user = r.rows[0]!;
    if (!(await verifyPassword(user.password_hash, password))) {
      throw new Error('Invalid email or password');
    }
    return {
      provider: 'local',
      providerUserId: user.id,
      email: user.email ?? email,
      displayName: user.name ?? undefined,
      // F-20 — local users have already passed the verify-email loop
      // by the time they can sign in (the login route gates on
      // email_verified_at). So asserting emailVerified is safe and
      // lets resolveIdentity link this identity to an existing
      // user row if any.
      emailVerified: true,
    };
  }
}

export const localProvider = new LocalAuthProvider();
